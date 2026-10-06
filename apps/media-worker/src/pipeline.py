from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable

import httpx

LRCLIB_URL = "https://lrclib.net/api/get"
SOURCE_SEPARATION_ENABLED = os.getenv("KARAOKE_ENABLE_SOURCE_SEPARATION", "true").lower() not in {
    "0",
    "false",
    "no",
}
MODEL_DIR = Path(
    os.getenv("AUDIO_SEPARATOR_MODEL_DIR", "./data/models")
).resolve()
MODEL_DIR.mkdir(parents=True, exist_ok=True)


class PipelineError(RuntimeError):
    pass


def report_progress(
    progress: Callable[[str, int, str], None] | None,
    stage: str,
    percent: int,
    message: str,
) -> None:
    if progress:
        progress(stage, max(0, min(100, percent)), message)


def run_command(args: list[str]) -> str:
    try:
        completed = subprocess.run(
            args,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return completed.stdout
    except FileNotFoundError as exc:
        raise PipelineError(f"Dependência nativa ausente: {args[0]}.") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "Comando falhou.")[-3000:]
        raise PipelineError(detail) from exc


def probe_duration(media_file: Path) -> float | None:
    raw = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(media_file),
        ]
    )
    data = json.loads(raw)
    value = data.get("format", {}).get("duration")
    return float(value) if value else None


def youtube_cookie_file() -> Path | None:
    configured = os.getenv("KARAOKE_YOUTUBE_COOKIES_FILE", "").strip()
    if not configured:
        return None

    cookie_file = Path(configured).expanduser().resolve()
    if not cookie_file.is_file():
        raise PipelineError(
            f"Arquivo de cookies do YouTube não encontrado: {cookie_file}"
        )
    if not os.access(cookie_file, os.R_OK):
        raise PipelineError(
            f"Arquivo de cookies do YouTube sem permissão de leitura: {cookie_file}"
        )
    return cookie_file


def yt_dlp_base_args(*, no_playlist: bool = False) -> list[str]:
    args = [
        "yt-dlp",
        "--ignore-config",
        *(["--no-playlist"] if no_playlist else []),
        "--no-warnings",
        "--restrict-filenames",
        "--newline",
        "--retries", "3",
        "--fragment-retries", "3",
        "--socket-timeout", "30",
    ]
    cookie_file = youtube_cookie_file()
    if cookie_file:
        args.extend(["--cookies", str(cookie_file)])
    return args


def run_download_command(
    args: list[str],
    progress: Callable[[float, str], None] | None = None,
) -> None:
    try:
        process = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except FileNotFoundError as exc:
        raise PipelineError(f"Dependência nativa ausente: {args[0]}.") from exc

    last_message = ""
    try:
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.strip()
            if not line:
                continue
            last_message = line
            match = re.search(r"(\d+(?:\.\d+)?)%", line)
            if match and progress:
                progress(float(match.group(1)), line)
        return_code = process.wait(timeout=1800)
    except subprocess.TimeoutExpired as exc:
        process.kill()
        process.wait()
        raise PipelineError("O download da música excedeu o limite de 30 minutos.") from exc

    if return_code != 0:
        raise PipelineError(last_message[-3000:] or "Falha no download da música.")


def download_source(
    source_url: str,
    folder: Path,
    media_kind: str,
    progress: Callable[[float, str], None] | None = None,
) -> Path:
    output = folder / "original.%(ext)s"
    if media_kind == "audio":
        format_args = ["-f", "bestaudio/best", "--extract-audio"]
    else:
        format_args = ["-f", "bv*+ba/b", "--merge-output-format", "mp4"]

    run_download_command(
        [
            *yt_dlp_base_args(no_playlist=True),
            *format_args,
            "-o", str(output),
            source_url,
        ],
        progress=progress,
    )

    candidates = sorted(
        p for p in folder.iterdir() if p.name.startswith("original.") and p.is_file()
    )
    if not candidates:
        raise PipelineError("Download concluído sem arquivo de saída.")
    return candidates[0]


def normalize_audio(source_file: Path, output_file: Path) -> float | None:
    run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source_file),
            "-vn",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-sample_fmt",
            "s16",
            "-c:a",
            "pcm_s16le",
            str(output_file),
        ]
    )
    return probe_duration(output_file)


def fetch_lyrics(
    track_name: str,
    artist_name: str,
    duration: float | None,
) -> dict[str, Any] | None:
    track_name = track_name.strip()
    artist_name = artist_name.strip()

    if not track_name:
        return None

    headers = {
        "User-Agent": "KaraokeAI/1.0 (https://github.com/karaokeai366/karaokeai366)"
    }

    with httpx.Client(timeout=15, headers=headers) as client:
        if artist_name:
            params: dict[str, str | float] = {
                "track_name": track_name,
                "artist_name": artist_name,
            }
            if duration is not None:
                params["duration"] = duration

            response = client.get(LRCLIB_URL, params=params)

            if response.status_code == 404:
                return None
            if response.status_code == 429:
                raise PipelineError(
                    f"LRCLIB limitou temporariamente a consulta. Retry-After={response.headers.get('Retry-After', 'unknown')}."
                )

            response.raise_for_status()
            return response.json()

        # O YouTube Music pode não fornecer o artista em resultados
        # flat. Nesse caso, /api/get retornaria 400 porque artist_name
        # é obrigatório. Pesquisamos pelo título e escolhemos a faixa
        # com duração mais próxima para manter a preparação resiliente.
        response = client.get(
            "https://lrclib.net/api/search",
            params={"track_name": track_name},
        )
        if response.status_code == 429:
            raise PipelineError(
                f"LRCLIB limitou temporariamente a consulta. Retry-After={response.headers.get('Retry-After', 'unknown')}."
            )
        response.raise_for_status()

        candidates = response.json()
        if not isinstance(candidates, list) or not candidates:
            return None

        def score(candidate: Any) -> tuple[int, float, int]:
            candidate_duration = candidate.get("duration")
            try:
                delta = abs(float(candidate_duration) - float(duration)) if duration is not None and candidate_duration is not None else 999999.0
            except (TypeError, ValueError):
                delta = 999999.0
            has_synced = 0 if str(candidate.get("syncedLyrics") or "").strip() else 1
            return (0 if delta <= 2 else 1, delta, has_synced)

        best = min(candidates, key=score)
        candidate_duration = best.get("duration")
        if duration is not None and candidate_duration is not None:
            try:
                if abs(float(candidate_duration) - float(duration)) > 2:
                    return None
            except (TypeError, ValueError):
                return None

        return best


def parse_lrc(synced_lyrics: str) -> list[dict[str, Any]]:
    pattern = re.compile(r"\[(\d{1,3}):(\d{2}(?:\.\d+)?)\](.*)")
    lines: list[dict[str, Any]] = []

    for raw_line in synced_lyrics.splitlines():
        matches = list(pattern.finditer(raw_line))
        if not matches:
            continue

        text = matches[-1].group(3).strip()
        for match in matches:
            minutes = int(match.group(1))
            seconds = float(match.group(2))
            lines.append(
                {
                    "start": round(minutes * 60 + seconds, 3),
                    "text": text,
                }
            )

    lines.sort(key=lambda item: item["start"])
    return lines


def write_lyrics_artifacts(folder: Path, lyrics: dict[str, Any]) -> tuple[str | None, str]:
    plain = str(lyrics.get("plainLyrics") or "").strip()
    synced = str(lyrics.get("syncedLyrics") or "").strip()

    lrc_path: str | None = None
    parsed_lines = parse_lrc(synced) if synced else []

    if synced:
        lrc_file = folder / "lyrics.lrc"
        lrc_file.write_text(synced.rstrip() + "\n", encoding="utf-8")
        lrc_path = lrc_file.name

    lyrics_json = folder / "lyrics.json"
    lyrics_json.write_text(
        json.dumps(
            {
                "provider": "LRCLIB",
                "trackName": str(lyrics.get("trackName") or ""),
                "artistName": str(lyrics.get("artistName") or ""),
                "durationSeconds": lyrics.get("duration"),
                "plainLyrics": plain or None,
                "syncedLyrics": synced or None,
                "lines": parsed_lines,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    return lrc_path, lyrics_json.name


def download_cover(url: str | None, folder: Path) -> str | None:
    if not url:
        return None

    try:
        with httpx.Client(timeout=10, follow_redirects=True) as client:
            response = client.get(url)
        response.raise_for_status()

        content_type = response.headers.get("content-type", "").lower()
        extension = ".jpg"
        if "png" in content_type:
            extension = ".png"
        elif "webp" in content_type:
            extension = ".webp"

        cover_file = folder / f"cover{extension}"
        cover_file.write_bytes(response.content)
        return cover_file.name
    except httpx.HTTPError:
        return None


def separate_sources(normalized_audio: Path, folder: Path) -> tuple[Path, Path]:
    if not SOURCE_SEPARATION_ENABLED:
        raise PipelineError(
            "Separação vocal está desativada. Defina KARAOKE_ENABLE_SOURCE_SEPARATION=true."
        )

    try:
        from audio_separator.separator import Separator
    except ImportError as exc:
        raise PipelineError(
            "audio-separator não está instalado no worker."
        ) from exc

    output_dir = folder / "separated"
    output_dir.mkdir(parents=True, exist_ok=True)

    separator = Separator(
        output_dir=str(output_dir),
        model_file_dir=str(MODEL_DIR),
        output_format="WAV",
        ensemble_preset="karaoke",
        use_soundfile=True,
    )
    separator.load_model()
    output_files = separator.separate(str(normalized_audio))

    if not output_files:
        raise PipelineError("O separador não produziu arquivos de saída.")

    vocals: Path | None = None
    instrumental: Path | None = None

    for output in output_files:
        path = Path(output)
        lower = path.name.lower()
        if "vocal" in lower:
            vocals = path
        elif "instrumental" in lower or "karaoke" in lower:
            instrumental = path

    if vocals is None or instrumental is None:
        for candidate in output_dir.glob("*"):
            if not candidate.is_file():
                continue
            lower = candidate.name.lower()
            if vocals is None and "vocal" in lower:
                vocals = candidate
            if instrumental is None and ("instrumental" in lower or "karaoke" in lower):
                instrumental = candidate

    if vocals is None or instrumental is None:
        produced = ", ".join(str(path) for path in output_files)
        raise PipelineError(
            f"Não foi possível identificar Vocals/Instrumental. Saídas: {produced}"
        )

    vocals_target = folder / "vocals.wav"
    instrumental_target = folder / "instrumental.wav"

    if vocals.resolve() != vocals_target.resolve():
        shutil.copyfile(vocals, vocals_target)
    if instrumental.resolve() != instrumental_target.resolve():
        shutil.copyfile(instrumental, instrumental_target)

    return vocals_target, instrumental_target


def _key_profiles() -> tuple[list[str], list[list[float]]]:
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    major = [
        6.35,
        2.23,
        3.48,
        2.33,
        4.38,
        4.09,
        2.52,
        5.19,
        2.39,
        3.66,
        2.29,
        2.88,
    ]
    minor = [
        6.33,
        2.68,
        3.52,
        5.38,
        2.60,
        3.53,
        2.54,
        4.75,
        3.98,
        2.69,
        3.34,
        3.17,
    ]
    labels = [f"{name} major" for name in names] + [f"{name} minor" for name in names]
    profiles = [major[i:] + major[:i] for i in range(12)]
    profiles += [minor[i:] + minor[:i] for i in range(12)]
    return labels, profiles


def _estimate_key(chroma: Any) -> tuple[str | None, float | None]:
    import numpy as np

    profile = np.asarray(chroma).mean(axis=1)
    if not np.any(profile):
        return None, None

    labels, templates = _key_profiles()
    profile = profile / (np.linalg.norm(profile) + 1e-12)

    scores: list[float] = []
    for template in templates:
        template_array = np.asarray(template, dtype=float)
        template_array /= np.linalg.norm(template_array) + 1e-12
        scores.append(float(np.dot(profile, template_array)))

    best = int(np.argmax(scores))
    confidence = max(0.0, min(1.0, (scores[best] + 1.0) / 2.0))
    return labels[best], round(confidence, 4)


def _compress_melody(
    f0: Any,
    voiced_flag: Any,
    voiced_probs: Any,
    sr: int,
    hop_length: int,
) -> list[dict[str, Any]]:
    import numpy as np

    events: list[dict[str, Any]] = []
    step = hop_length / sr
    current: dict[str, Any] | None = None

    for index, frequency in enumerate(f0):
        if not bool(voiced_flag[index]) or not np.isfinite(frequency):
            if current is not None:
                current["end"] = round(index * step, 3)
                if current["end"] > current["start"]:
                    events.append(current)
                current = None
            continue

        midi = 69.0 + 12.0 * math.log2(float(frequency) / 440.0)
        midi_note = round(midi * 2) / 2
        confidence = float(voiced_probs[index])

        if (
            current is not None
            and current["midi"] == midi_note
            and index * step - current["end"] <= step * 1.5
        ):
            current["end"] = round((index + 1) * step, 3)
            current["confidenceSum"] += confidence
            current["samples"] += 1
        else:
            if current is not None:
                events.append(
                    {
                        "start": current["start"],
                        "end": current["end"],
                        "midi": current["midi"],
                        "frequencyHz": current["frequencyHz"],
                        "confidence": round(
                            current["confidenceSum"] / current["samples"], 4
                        ),
                    }
                )
            current = {
                "start": round(index * step, 3),
                "end": round((index + 1) * step, 3),
                "midi": midi_note,
                "frequencyHz": round(float(frequency), 3),
                "confidenceSum": confidence,
                "samples": 1,
            }

    if current is not None:
        events.append(
            {
                "start": current["start"],
                "end": current["end"],
                "midi": current["midi"],
                "frequencyHz": current["frequencyHz"],
                "confidence": round(
                    current["confidenceSum"] / current["samples"], 4
                ),
            }
        )

    return events


def analyze_melody(vocals_file: Path, output_file: Path) -> dict[str, Any]:
    try:
        import librosa
        import numpy as np
    except ImportError as exc:
        raise PipelineError("librosa/numpy não estão instalados no worker.") from exc

    analysis_sr = 22050
    hop_length = 512
    y, sr = librosa.load(str(vocals_file), sr=analysis_sr, mono=True)

    if y.size == 0:
        raise PipelineError("A faixa vocal está vazia.")

    f0, voiced_flag, voiced_probs = librosa.pyin(
        y,
        fmin=65.406,
        fmax=1046.5,
        sr=sr,
        frame_length=2048,
        hop_length=hop_length,
    )
    if f0 is None:
        raise PipelineError("Não foi possível estimar a melodia vocal.")

    chroma = librosa.feature.chroma_stft(y=y, sr=sr)
    key_name, key_confidence = _estimate_key(chroma)

    tempo_result = librosa.beat.beat_track(y=y, sr=sr)
    if isinstance(tempo_result, tuple):
        tempo = tempo_result[0]
    else:
        tempo = tempo_result
    try:
        bpm = float(np.asarray(tempo).reshape(-1)[0])
    except (ValueError, IndexError):
        bpm = None

    events = _compress_melody(
        f0,
        voiced_flag,
        voiced_probs,
        sr,
        hop_length,
    )

    for event in events:
        event.pop("confidenceSum", None)
        event.pop("samples", None)

    payload = {
        "schemaVersion": 1,
        "generatedBy": {
            "engine": "librosa",
            "algorithm": "pyin",
        },
        "sampleRate": sr,
        "hopLength": hop_length,
        "durationSeconds": round(len(y) / sr, 3),
        "key": {
            "name": key_name,
            "confidence": key_confidence,
        },
        "bpm": round(bpm, 3) if bpm is not None else None,
        "notes": events,
    }

    output_file.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return payload


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def relative_artifact(path: Path, asset_id: str) -> str:
    return f"/media/{asset_id}/{path.name}"


def build_manifest(
    asset_id: str,
    source: dict[str, Any],
    media_kind: str,
    duration_seconds: float | None,
    folder: Path,
    original: Path,
    instrumental: Path | None,
    vocals: Path | None,
    lyrics_lrc: str | None,
    lyrics_json: str | None,
    melody_file: Path | None,
    cover_name: str | None,
    lyric_state: str,
    separation_state: str,
    melody_state: str,
    melody_payload: dict[str, Any] | None,
) -> dict[str, Any]:
    files: dict[str, str] = {
        "original": relative_artifact(original, asset_id),
    }
    if instrumental:
        files["instrumental"] = relative_artifact(instrumental, asset_id)
    if vocals:
        files["vocals"] = relative_artifact(vocals, asset_id)
    if lyrics_lrc:
        files["lyricsLrc"] = relative_artifact(folder / lyrics_lrc, asset_id)
    if lyrics_json:
        files["lyricsJson"] = relative_artifact(folder / lyrics_json, asset_id)
    if melody_file:
        files["melodyJson"] = relative_artifact(melody_file, asset_id)
    if cover_name:
        files["cover"] = relative_artifact(folder / cover_name, asset_id)

    original_key = (
        ((melody_payload or {}).get("key") or {}).get("name")
        if melody_payload
        else None
    )
    bpm = (melody_payload or {}).get("bpm")

    artifact_paths = [
        path
        for path in (
            original,
            instrumental,
            vocals,
            folder / lyrics_lrc if lyrics_lrc else None,
            folder / lyrics_json if lyrics_json else None,
            melody_file,
            folder / cover_name if cover_name else None,
        )
        if path is not None and path.exists()
    ]

    integrity = {relative_artifact(path, asset_id): file_sha256(path) for path in artifact_paths}

    return {
        "schemaVersion": 1,
        "assetId": asset_id,
        "createdAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
        "source": source,
        "mediaKind": media_kind,
        "durationSeconds": duration_seconds,
        "originalKey": original_key,
        "selectedKey": original_key,
        "bpm": bpm,
        "files": files,
        "integrity": integrity,
        "preparation": {
            "download": "ready",
            "lyrics": lyric_state,
            "separation": separation_state,
            "melody": melody_state,
            "key": "ready",
        },
    }


def prepare_asset(
    *,
    asset_id: str,
    source: dict[str, Any],
    media_kind: str,
    root: Path,
    progress: Callable[[str, int, str], None] | None = None,
) -> dict[str, Any]:
    folder = root / asset_id
    folder.mkdir(parents=True, exist_ok=True)

    source_url = str(source.get("sourceUrl") or "").strip()
    if not (source_url.startswith("https://") or source_url.startswith("http://")):
        raise PipelineError("A fonte deve ser uma URL HTTP(S).")

    report_progress(progress, "download", 5, "Conectando à fonte da música…")

    def download_progress(percent: float, detail: str) -> None:
        mapped = 5 + round(max(0.0, min(100.0, percent)) * 0.17)
        report_progress(progress, "download", mapped, f"Baixando a música… {percent:.1f}%")

    original = download_source(source_url, folder, media_kind, download_progress)
    report_progress(progress, "download", 22, "Download concluído. Preparando o áudio…")
    report_progress(progress, "normalize", 25, "Normalizando o áudio…")
    normalized = folder / "mix.wav"
    duration_seconds = normalize_audio(original, normalized)

    lyric_state = "missing"
    lyrics_lrc: str | None = None
    lyrics_json: str | None = None

    report_progress(progress, "lyrics", 35, "Buscando letra sincronizada…")
    lyrics_data = fetch_lyrics(
        str(source.get("title") or ""),
        str(source.get("artist") or ""),
        duration_seconds,
    )
    if lyrics_data:
        lyrics_lrc, lyrics_json = write_lyrics_artifacts(folder, lyrics_data)
        if lyrics_lrc or lyrics_json:
            lyric_state = "ready"

    report_progress(progress, "cover", 45, "Preparando capa…")
    cover_name = download_cover(
        str(source.get("thumbnailUrl") or "").strip() or None,
        folder,
    )

    vocals: Path | None = None
    instrumental: Path | None = None
    melody_file: Path | None = None
    separation_state = "error"
    melody_state = "error"
    melody_payload: dict[str, Any] | None = None

    report_progress(progress, "separation", 55, "Separando voz e instrumental…")
    vocals, instrumental = separate_sources(normalized, folder)
    separation_state = "ready"

    report_progress(progress, "melody", 82, "Analisando melodia, tom e BPM…")
    melody_file = folder / "melody.json"
    melody_payload = analyze_melody(vocals, melody_file)
    melody_state = "ready"

    report_progress(progress, "manifest", 94, "Montando o SongAsset…")
    manifest = build_manifest(
        asset_id,
        source,
        media_kind,
        duration_seconds,
        folder,
        original,
        instrumental,
        vocals,
        lyrics_lrc,
        lyrics_json,
        melody_file,
        cover_name,
        lyric_state,
        separation_state,
        melody_state,
        melody_payload,
    )

    manifest_path = folder / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    manifest["files"]["manifest"] = relative_artifact(manifest_path, asset_id)
    report_progress(progress, "ready", 100, "Música pronta para cantar.")
    return manifest

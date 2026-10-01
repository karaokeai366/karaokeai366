from __future__ import annotations

import json
import math
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any


PITCH_CLASSES = {
    "C": 0,
    "C#": 1,
    "Db": 1,
    "D": 2,
    "D#": 3,
    "Eb": 3,
    "E": 4,
    "F": 5,
    "F#": 6,
    "Gb": 6,
    "G": 7,
    "G#": 8,
    "Ab": 8,
    "A": 9,
    "A#": 10,
    "Bb": 10,
    "B": 11,
}


def _pitch_class(key_name: str | None) -> int | None:
    if not key_name:
        return None

    match = re.match(r"^\s*([A-Ga-g](?:#|b)?)", key_name)
    if not match:
        return None

    value = match.group(1)
    normalized = value[0].upper() + value[1:]
    return PITCH_CLASSES.get(normalized)


def semitone_delta(original_key: str | None, target_key: str) -> int:
    source = _pitch_class(original_key)
    target = _pitch_class(target_key)

    if source is None:
        raise ValueError(f"Tom original inválido: {original_key!r}.")
    if target is None:
        raise ValueError(f"Tom de destino inválido: {target_key!r}.")

    delta = (target - source) % 12
    if delta > 6:
        delta -= 12
    return delta


def transpose_melody_payload(payload: dict[str, Any], semitones: int, selected_key: str) -> dict[str, Any]:
    notes = []

    for note in payload.get("notes", []):
        if not isinstance(note, dict):
            continue

        updated = dict(note)
        if isinstance(updated.get("midi"), (int, float)):
            updated["midi"] = round(float(updated["midi"]) + semitones, 3)
        if isinstance(updated.get("frequencyHz"), (int, float)):
            updated["frequencyHz"] = round(
                float(updated["frequencyHz"]) * (2 ** (semitones / 12)),
                3,
            )
        notes.append(updated)

    result = dict(payload)
    result["notes"] = notes
    result["selectedKey"] = selected_key
    result["transpositionSemitones"] = semitones
    result["transposedFromKey"] = payload.get("key", {}).get("name")

    return result


def transpose_asset_key(
    *,
    root: Path,
    asset_id: str,
    target_key: str,
) -> dict[str, Any]:
    folder = root / asset_id
    manifest_path = folder / "manifest.json"

    if not manifest_path.exists():
        raise ValueError("SongAsset não encontrado.")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    original_key = manifest.get("originalKey")
    delta = semitone_delta(original_key, target_key)

    if abs(delta) > 6:
        raise ValueError("A mudança de tom precisa ser de no máximo 6 semitons no caminho mais curto.")

    instrumental_name = manifest.get("files", {}).get("instrumental")
    melody_name = manifest.get("files", {}).get("melodyJson")

    if not instrumental_name or not melody_name:
        raise ValueError("SongAsset ainda não possui instrumental e melodia.")

    instrumental_path = folder / Path(instrumental_name).name
    melody_path = folder / Path(melody_name).name

    if not instrumental_path.exists() or not melody_path.exists():
        raise ValueError("Artefatos do SongAsset não encontrados.")

    base_instrumental_path = folder / "instrumental.base.wav"
    base_melody_path = folder / "melody.base.json"

    if not base_instrumental_path.exists():
        shutil.copyfile(instrumental_path, base_instrumental_path)
    if not base_melody_path.exists():
        shutil.copyfile(melody_path, base_melody_path)

    if delta == 0:
        shutil.copyfile(base_instrumental_path, instrumental_path)
    else:
        try:
            import librosa
            import soundfile as sf
        except ImportError as exc:
            raise ValueError("librosa e soundfile são necessários para transpor o instrumental.") from exc

        audio, sr = librosa.load(
            str(base_instrumental_path),
            sr=None,
            mono=False,
        )

        shifted = librosa.effects.pitch_shift(
            audio,
            sr=sr,
            n_steps=delta,
        )

        with tempfile.NamedTemporaryFile(
            dir=folder,
            prefix="instrumental.",
            suffix=".wav",
            delete=False,
        ) as temp:
            temp_path = Path(temp.name)

        try:
            sf.write(str(temp_path), shifted.T if getattr(shifted, "ndim", 1) > 1 else shifted, sr)
            temp_path.replace(instrumental_path)
        finally:
            temp_path.unlink(missing_ok=True)

    melody_payload = json.loads(base_melody_path.read_text(encoding="utf-8"))
    melody_transposed = transpose_melody_payload(
        melody_payload,
        delta,
        target_key,
    )
    melody_path.write_text(
        json.dumps(melody_transposed, ensure_ascii=False, indent=2) + "\\n",
        encoding="utf-8",
    )

    manifest["selectedKey"] = target_key
    manifest["integrity"] = {
        **manifest.get("integrity", {}),
        manifest["files"]["instrumental"]: file_sha256(instrumental_path),
        manifest["files"]["melodyJson"]: file_sha256(melody_path),
    }
    manifest.setdefault("preparation", {})["key"] = "ready"

    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\\n",
        encoding="utf-8",
    )

    return manifest


from .pipeline import file_sha256

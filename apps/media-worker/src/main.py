from __future__ import annotations

import asyncio
import difflib
import hashlib
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Any
from uuid import uuid4
from urllib.parse import quote_plus

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .pipeline import (
    PipelineError,
    PreparationCancelled,
    SOURCE_SEPARATION_ENABLED,
    prepare_asset,
    yt_dlp_base_args,
    youtube_cookie_file,
)
from .key_transposer import transpose_asset_key
from pydantic import BaseModel, Field

APP_VERSION = "0.1.0"
ROOT = Path(os.getenv("KARAOKE_MEDIA_ROOT", "./data/media")).resolve()
ROOT.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="KaraokeAI Media Worker", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.mount("/media", StaticFiles(directory=str(ROOT)), name="media")

type PrepareJob = dict[str, Any]
prepare_jobs: dict[str, PrepareJob] = {}
prepare_cancel_events: dict[str, threading.Event] = {}
# Source separation is CPU/RAM intensive; serialize only this stage so
# downloads, metadata and other lightweight preparation work can overlap.
source_separation_lock = threading.Lock()


def update_prepare_job(job_id: str, stage: str, percent: int, message: str) -> None:
    job = prepare_jobs.get(job_id)
    if not job or job.get("status") == "cancelled":
        return
    job.update({
        "status": "running",
        "stage": stage,
        "progress": percent,
        "message": message,
        "updatedAt": time.monotonic(),
    })


def cached_manifest(asset_id: str) -> dict[str, Any] | None:
    manifest_path = ROOT / asset_id / "manifest.json"
    if not manifest_path.is_file():
        return None

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

    preparation = manifest.get("preparation") or {}
    files = manifest.get("files") or {}
    required = (
        preparation.get("download") == "ready"
        and preparation.get("separation") == "ready"
        and preparation.get("melody") == "ready"
        and bool(files.get("instrumental"))
        and bool(files.get("vocals"))
    )
    if not required:
        return None

    for key in ("instrumental", "vocals"):
        path = ROOT / asset_id / str(files[key])
        if not path.is_file():
            return None

    return manifest


async def run_prepare_job(
    job_id: str,
    request: PrepareRequest,
    source: dict[str, Any],
    cancel_event: threading.Event,
) -> None:
    try:
        prepare_jobs[job_id].update({"status": "running"})

        # Reuse the same asset for repeated requests of the same source.
        # This turns a previously prepared song into an immediate cache hit.
        cache_key = request.source_id or request.source_url.strip()
        asset_id = (
            safe_asset_id(request.asset_id)
            if request.asset_id
            else hashlib.sha256(
                f"{request.media_kind}:{cache_key}".encode("utf-8")
            ).hexdigest()[:32]
        )

        cached = cached_manifest(asset_id)
        if cached is not None:
            prepare_jobs[job_id].update({
                "status": "ready",
                "stage": "ready",
                "progress": 100,
                "message": "Música já preparada; reutilizando o SongAsset.",
                "manifest": cached,
                "updatedAt": asyncio.get_event_loop().time(),
            })
            return

        manifest = await asyncio.to_thread(
            prepare_asset,
            asset_id=asset_id,
            source=source,
            media_kind=request.media_kind,
            root=ROOT,
            separation_lock=source_separation_lock,
            cancel_check=cancel_event.is_set,
            progress=lambda stage, percent, message: update_prepare_job(
                job_id, stage, percent, message
            ),
        )
        prepare_jobs[job_id].update({
            "status": "ready",
            "stage": "ready",
            "progress": 100,
            "message": "Música pronta para cantar.",
            "manifest": manifest,
            "updatedAt": asyncio.get_event_loop().time(),
        })
    except PreparationCancelled as exc:
        prepare_jobs[job_id].update({
            "status": "cancelled",
            "stage": "cancelled",
            "message": str(exc),
            "updatedAt": asyncio.get_event_loop().time(),
        })
    except PipelineError as exc:
        prepare_jobs[job_id].update({
            "status": "error",
            "stage": "error",
            "message": str(exc),
            "updatedAt": asyncio.get_event_loop().time(),
        })
    except Exception as exc:
        prepare_jobs[job_id].update({
            "status": "error",
            "stage": "error",
            "message": f"Falha na preparação da música: {exc}",
            "updatedAt": asyncio.get_event_loop().time(),
        })
    finally:
        prepare_cancel_events.pop(job_id, None)


class SearchResult(BaseModel):
    source_id: str
    source: str
    title: str
    artist: str | None = None
    prepared: bool = False
    asset_id: str | None = None
    manifest_url: str | None = None
    album: str | None = None
    channel_name: str | None = None
    duration_seconds: float | None = None
    thumbnail_url: str | None = None
    source_url: str


class SearchResponse(BaseModel):
    results: list[SearchResult]
    page: int = 1
    page_size: int = 8
    has_more: bool = False


class DownloadRequest(BaseModel):
    source_url: str = Field(min_length=1)
    media_kind: str = Field(default="video", pattern="^(audio|video)$")
    asset_id: str | None = None


class KeyTranspositionRequest(BaseModel):
    asset_id: str = Field(min_length=1, max_length=64)
    target_key: str = Field(min_length=1, max_length=4)


class PrepareRequest(BaseModel):
    source_url: str = Field(min_length=1)
    media_kind: str = Field(default="video", pattern="^(audio|video)$")
    asset_id: str | None = None
    source_id: str | None = None
    source: str | None = None
    title: str = Field(min_length=1, max_length=160)
    artist: str | None = Field(default=None, max_length=160)
    album: str | None = Field(default=None, max_length=160)
    channel_name: str | None = Field(default=None, max_length=200)
    thumbnail_url: str | None = Field(default=None, max_length=2000)


class DownloadResponse(BaseModel):
    asset_id: str
    original_file: str
    duration_seconds: float | None = None


class LyricsResponse(BaseModel):
    provider: str
    found: bool
    track_name: str
    artist_name: str
    duration_seconds: float | None = None
    plain_lyrics: str | None = None
    synced_lyrics: str | None = None


def _youtube_cookie_configured() -> bool:
    try:
        return youtube_cookie_file() is not None
    except PipelineError:
        return False


def enrich_music_metadata_from_lrclib(
    title: str,
    duration: float | None,
) -> tuple[str | None, str | None]:
    """Best-effort metadata enrichment; failure must never break search."""
    normalized_title = title.strip()
    if not normalized_title:
        return None, None

    try:
        with httpx.Client(timeout=4, headers={
            "User-Agent": "KaraokeAI/1.0 (https://github.com/karaokeai366/karaokeai366)"
        }) as client:
            response = client.get(
                "https://lrclib.net/api/search",
                params={"track_name": normalized_title},
            )
            if response.status_code != 200:
                return None, None
            candidates = response.json()
    except (httpx.HTTPError, ValueError):
        return None, None

    if not isinstance(candidates, list):
        return None, None

    def score(candidate: Any) -> tuple[float, float]:
        candidate_title = str(candidate.get("trackName") or "")
        title_similarity = difflib.SequenceMatcher(
            None,
            normalized_title.casefold(),
            candidate_title.casefold(),
        ).ratio()
        candidate_duration = candidate.get("duration")
        duration_delta = 999999.0
        try:
            if duration is not None and candidate_duration is not None:
                duration_delta = abs(float(candidate_duration) - float(duration))
        except (TypeError, ValueError):
            pass
        return (title_similarity, -duration_delta)

    candidates = [
        candidate for candidate in candidates
        if isinstance(candidate, dict) and str(candidate.get("artistName") or "").strip()
    ]
    if not candidates:
        return None, None

    best = max(candidates, key=score)
    similarity, _ = score(best)
    if similarity < 0.75:
        return None, None

    artist = str(best.get("artistName") or "").strip() or None
    album = str(best.get("albumName") or "").strip() or None
    return artist, album


def validate_source_url(url: str) -> str:
    url = url.strip()
    if not (url.startswith("https://") or url.startswith("http://")):
        raise HTTPException(status_code=400, detail="A fonte deve ser uma URL HTTP(S).")
    return url


def safe_asset_id(value: str | None) -> str:
    if value and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value):
        return value
    return uuid4().hex


def run_command(args: list[str], *, timeout_seconds: float | None = None) -> str:
    import subprocess

    try:
        completed = subprocess.run(
            args,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
        return completed.stdout
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(
            status_code=504,
            detail=f"O serviço de busca demorou mais de {timeout_seconds:g}s para responder.",
        ) from exc
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Dependência nativa ausente: {args[0]}.",
        ) from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "Comando falhou.")[-2000:]
        raise HTTPException(status_code=422, detail=detail) from exc


@app.get("/health")
def health() -> dict[str, Any]:
    deno_available = shutil.which("deno") is not None
    try:
        import yt_dlp_ejs  # type: ignore[import-not-found]
        ejs_available = yt_dlp_ejs is not None
    except ImportError:
        ejs_available = False

    return {
        "status": "ok",
        "version": APP_VERSION,
        "yt_dlp": shutil.which("yt-dlp") is not None,
        "yt_dlp_ejs": ejs_available,
        "deno": deno_available,
        "youtube_ready": deno_available and ejs_available,
        "youtube_cookies_configured": _youtube_cookie_configured(),
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "ffprobe": shutil.which("ffprobe") is not None,
        "audio_separator": shutil.which("audio-separator") is not None,
        "source_separation_enabled": SOURCE_SEPARATION_ENABLED,
        "key_transposition": True,
    }


@app.get("/search", response_model=SearchResponse)
def search(
    q: str = Query(min_length=2, max_length=160),
    page: int = Query(default=1, ge=1, le=100),
    limit: int = Query(default=8, ge=1, le=15),
) -> SearchResponse:
    normalized_query = q.strip()
    music_search = f"https://music.youtube.com/search?q={quote_plus(normalized_query)}#songs"
    using_music_catalog = True

    try:
        raw = run_command(
            [
                *yt_dlp_base_args(),
                "--flat-playlist",
                "--dump-single-json",
                "--skip-download",
                music_search,
            ],
            timeout_seconds=12,
        )
        payload = json.loads(raw)
        entries = payload.get("entries", [])
    except HTTPException:
        using_music_catalog = False
        query = f"ytsearch{limit}:{normalized_query}"
        raw = run_command(
            [
                *yt_dlp_base_args(),
                "--flat-playlist",
                "--dump-single-json",
                "--skip-download",
                query,
            ],
            timeout_seconds=12,
        )
        payload = json.loads(raw)
        entries = payload.get("entries", [])
    results: list[SearchResult] = []

    for entry in entries:
        if not entry:
            continue
        source_id = entry.get("id")
        source_url = entry.get("webpage_url") or entry.get("url")
        if source_id and (not source_url or str(source_url) == str(source_id)):
            source_url = f"https://www.youtube.com/watch?v={source_id}"
        if not source_url or not source_id:
            continue
        title = str(entry.get("title") or "Sem título")
        artist = (
            ", ".join(str(item) for item in entry.get("artists", []) if item)
            or entry.get("artist")
            or entry.get("creator")
        )
        album = entry.get("album")
        if not artist and len(results) < 3:
            enriched_artist, enriched_album = enrich_music_metadata_from_lrclib(
                title,
                entry.get("duration"),
            )
            artist = enriched_artist
            album = album or enriched_album

        source_id_text = str(source_id)
        cache_key = source_id_text
        asset_id = hashlib.sha256(
            f"video:{cache_key}".encode("utf-8")
        ).hexdigest()[:32]
        cached = cached_manifest(asset_id)

        results.append(
            SearchResult(
                source_id=source_id_text,
                source="youtube-music" if using_music_catalog else "youtube",
                prepared=cached is not None,
                asset_id=asset_id if cached is not None else None,
                manifest_url=(
                    f"/media/{asset_id}/manifest.json"
                    if cached is not None
                    else None
                ),
                title=title,
                artist=artist,
                album=album,
                channel_name=entry.get("channel") or entry.get("uploader"),
                duration_seconds=entry.get("duration"),
                thumbnail_url=entry.get("thumbnail") or (
                    f"https://i.ytimg.com/vi/{source_id}/hqdefault.jpg"
                    if str(entry.get("ie_key") or "").lower().startswith("youtube")
                    or str(source_url).startswith("https://www.youtube.com/")
                    else None
                ),
                source_url=str(source_url),
            )
        )

    start = (page - 1) * limit
    paged_results = results[start : start + limit]
    return SearchResponse(
        results=paged_results,
        page=page,
        page_size=limit,
        has_more=start + limit < len(results),
    )


@app.get("/lyrics", response_model=LyricsResponse)
async def lyrics(
    track_name: str = Query(min_length=1, max_length=160),
    artist_name: str = Query(default="", max_length=160),
    duration: float | None = Query(default=None, ge=1, le=3600),
) -> LyricsResponse:
    params: dict[str, str | float] = {
        "track_name": track_name,
        "artist_name": artist_name,
    }
    if duration is not None:
        params["duration"] = duration

    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get("https://lrclib.net/api/get", params=params)

    if response.status_code == 404:
        return LyricsResponse(
            provider="LRCLIB",
            found=False,
            track_name=track_name,
            artist_name=artist_name,
            duration_seconds=duration,
        )

    if response.status_code == 429:
        retry_after = response.headers.get("Retry-After", "unknown")
        raise HTTPException(
            status_code=429,
            detail=f"LRCLIB limitou temporariamente a consulta. Retry-After={retry_after}.",
        )

    response.raise_for_status()
    data = response.json()

    return LyricsResponse(
        provider="LRCLIB",
        found=bool(data.get("plainLyrics") or data.get("syncedLyrics")),
        track_name=str(data.get("trackName") or track_name),
        artist_name=str(data.get("artistName") or artist_name),
        duration_seconds=data.get("duration"),
        plain_lyrics=data.get("plainLyrics"),
        synced_lyrics=data.get("syncedLyrics"),
    )


@app.post("/prepare")
async def prepare(request: PrepareRequest) -> dict[str, Any]:
    source = {
        "sourceId": request.source_id,
        "source": request.source,
        "title": request.title.strip(),
        "artist": request.artist.strip() if request.artist else None,
        "album": request.album.strip() if request.album else None,
        "channelName": request.channel_name.strip() if request.channel_name else None,
        "thumbnailUrl": request.thumbnail_url.strip() if request.thumbnail_url else None,
        "sourceUrl": request.source_url.strip(),
    }

    cache_key = request.source_id or request.source_url.strip()
    for existing_job in prepare_jobs.values():
        if (
            existing_job.get("status") in {"queued", "running"}
            and existing_job.get("cacheKey") == cache_key
        ):
            return {
                "jobId": existing_job["jobId"],
                "status": existing_job["status"],
                "stage": existing_job.get("stage", "queued"),
                "progress": existing_job.get("progress", 0),
                "message": existing_job.get("message", "Preparação já em andamento."),
            }

    job_id = uuid4().hex
    prepare_cancel_events[job_id] = threading.Event()
    prepare_jobs[job_id] = {
        "jobId": job_id,
        "status": "queued",
        "stage": "queued",
        "progress": 0,
        "message": "Preparação aguardando início…",
        "createdAt": asyncio.get_event_loop().time(),
        "updatedAt": asyncio.get_event_loop().time(),
        "cacheKey": cache_key,
    }

    asyncio.create_task(
        run_prepare_job(
            job_id,
            request,
            source,
            prepare_cancel_events[job_id],
        )
    )

    return {
        "jobId": job_id,
        "status": "queued",
        "stage": "queued",
        "progress": 0,
        "message": "Preparação iniciada.",
    }


@app.post("/prepare/{job_id}/cancel")
async def cancel_prepare(job_id: str) -> dict[str, Any]:
    job = prepare_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job de preparação não encontrado.")

    status = str(job.get("status") or "")
    if status in {"ready", "error", "cancelled"}:
        return {
            "jobId": job_id,
            "status": status,
            "stage": job.get("stage", status),
            "progress": job.get("progress", 0),
            "message": job.get("message", "Job já finalizado."),
        }

    cancel_event = prepare_cancel_events.get(job_id)
    if cancel_event is None:
        raise HTTPException(status_code=409, detail="Job não pode mais ser cancelado.")

    cancel_event.set()
    job.update({
        "status": "cancelled",
        "stage": "cancelled",
        "message": "Cancelando processamento da música…",
        "updatedAt": asyncio.get_event_loop().time(),
    })

    return {
        "jobId": job_id,
        "status": "cancelled",
        "stage": "cancelled",
        "progress": job.get("progress", 0),
        "message": "Processamento cancelado.",
    }


@app.get("/prepare/{job_id}")
async def prepare_status(job_id: str) -> dict[str, Any]:
    job = prepare_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job de preparação não encontrado.")

    result = dict(job)
    manifest = result.pop("manifest", None)
    if manifest is not None:
        result["manifest"] = manifest
        result["manifestUrl"] = f"/media/{manifest['assetId']}/manifest.json"
    return result


@app.post("/transpose-key")
async def transpose_key(request: KeyTranspositionRequest) -> dict[str, Any]:
    asset_id = safe_asset_id(request.asset_id)
    target_key = request.target_key.strip()

    try:
        manifest = await asyncio.to_thread(
            transpose_asset_key,
            root=ROOT,
            asset_id=asset_id,
            target_key=target_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Falha ao alterar o tom: {exc}") from exc

    return {
        "assetId": manifest["assetId"],
        "originalKey": manifest.get("originalKey"),
        "selectedKey": manifest.get("selectedKey"),
        "manifest": manifest,
        "manifestUrl": f"/media/{asset_id}/manifest.json",
    }


@app.post("/download", response_model=DownloadResponse)
async def download(request: DownloadRequest) -> DownloadResponse:
    source_url = validate_source_url(request.source_url)
    asset_id = safe_asset_id(request.asset_id)
    folder = ROOT / asset_id
    folder.mkdir(parents=True, exist_ok=True)

    output = folder / "original.%(ext)s"

    if request.media_kind == "audio":
        format_args = ["-f", "bestaudio/best", "--extract-audio"]
    else:
        format_args = ["-f", "bv*+ba/b", "--merge-output-format", "mp4"]

    run_command(
        [
            "yt-dlp",
            "--no-playlist",
            "--no-warnings",
            "--restrict-filenames",
            *format_args,
            "-o",
            str(output),
            source_url,
        ]
    )

    candidates = [p for p in folder.iterdir() if p.name.startswith("original.")]
    if not candidates:
        raise HTTPException(status_code=500, detail="Download concluído sem arquivo de saída.")

    media_file = candidates[0]
    probe = json.loads(
        run_command(
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
    )
    duration_value = probe.get("format", {}).get("duration")

    return DownloadResponse(
        asset_id=asset_id,
        original_file=str(media_file),
        duration_seconds=float(duration_value) if duration_value else None,
    )

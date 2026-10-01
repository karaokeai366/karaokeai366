from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any
from uuid import uuid4
from urllib.parse import quote_plus

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .pipeline import PipelineError, SOURCE_SEPARATION_ENABLED, prepare_asset
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


def update_prepare_job(job_id: str, stage: str, percent: int, message: str) -> None:
    job = prepare_jobs.get(job_id)
    if not job:
        return
    job.update({
        "status": "running",
        "stage": stage,
        "progress": percent,
        "message": message,
        "updatedAt": asyncio.get_event_loop().time(),
    })


async def run_prepare_job(
    job_id: str,
    request: PrepareRequest,
    source: dict[str, Any],
) -> None:
    try:
        prepare_jobs[job_id].update({"status": "running"})
        manifest = await asyncio.to_thread(
            prepare_asset,
            asset_id=safe_asset_id(request.asset_id),
            source=source,
            media_kind=request.media_kind,
            root=ROOT,
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



class SearchResult(BaseModel):
    source_id: str
    source: str
    title: str
    artist: str | None = None
    album: str | None = None
    channel_name: str | None = None
    duration_seconds: float | None = None
    thumbnail_url: str | None = None
    source_url: str


class SearchResponse(BaseModel):
    results: list[SearchResult]


class DownloadRequest(BaseModel):
    source_url: str = Field(min_length=1)
    media_kind: str = Field(default="video", pattern="^(audio|video)$")
    asset_id: str | None = None


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


def validate_source_url(url: str) -> str:
    url = url.strip()
    if not (url.startswith("https://") or url.startswith("http://")):
        raise HTTPException(status_code=400, detail="A fonte deve ser uma URL HTTP(S).")
    return url


def safe_asset_id(value: str | None) -> str:
    if value and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value):
        return value
    return uuid4().hex


def run_command(args: list[str]) -> str:
    import subprocess

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
        raise HTTPException(
            status_code=503,
            detail=f"Dependência nativa ausente: {args[0]}.",
        ) from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "Comando falhou.")[-2000:]
        raise HTTPException(status_code=422, detail=detail) from exc


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "version": APP_VERSION,
        "yt_dlp": shutil.which("yt-dlp") is not None,
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "ffprobe": shutil.which("ffprobe") is not None,
        "audio_separator": shutil.which("audio-separator") is not None,
        "source_separation_enabled": SOURCE_SEPARATION_ENABLED,
    }


@app.get("/search", response_model=SearchResponse)
def search(
    q: str = Query(min_length=2, max_length=160),
    limit: int = Query(default=8, ge=1, le=15),
) -> SearchResponse:
    normalized_query = q.strip()
    music_search = f"https://music.youtube.com/search?q={quote_plus(normalized_query)}#songs"
    using_music_catalog = True

    try:
        raw = run_command(
            [
                "yt-dlp",
                "--flat-playlist",
                "--dump-single-json",
                "--skip-download",
                "--no-warnings",
                music_search,
            ]
        )
        payload = json.loads(raw)
        entries = payload.get("entries", [])
    except HTTPException:
        using_music_catalog = False
        query = f"ytsearch{limit}:{normalized_query}"
        raw = run_command(
            [
                "yt-dlp",
                "--flat-playlist",
                "--dump-single-json",
                "--skip-download",
                "--no-warnings",
                query,
            ]
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
        results.append(
            SearchResult(
                source_id=str(source_id),
                source="youtube-music" if using_music_catalog else "youtube",
                title=str(entry.get("title") or "Sem título"),
                artist=(
                    ", ".join(str(item) for item in entry.get("artists", []) if item)
                    or entry.get("artist")
                    or entry.get("creator")
                    or entry.get("uploader")
                    or entry.get("channel")
                ),
                album=entry.get("album"),
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

    return SearchResponse(results=results)


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

    job_id = uuid4().hex
    prepare_jobs[job_id] = {
        "jobId": job_id,
        "status": "queued",
        "stage": "queued",
        "progress": 0,
        "message": "Preparação aguardando início…",
        "createdAt": asyncio.get_event_loop().time(),
        "updatedAt": asyncio.get_event_loop().time(),
    }

    asyncio.create_task(run_prepare_job(job_id, request, source))

    return {
        "jobId": job_id,
        "status": "queued",
        "stage": "queued",
        "progress": 0,
        "message": "Preparação iniciada.",
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

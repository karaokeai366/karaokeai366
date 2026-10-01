# KaraokeAI Media Worker

Optional local worker for media discovery and preparation.

## What it does now

- Search public media-source metadata using yt-dlp's search support.
- Download an explicitly selected source URL to the worker's local storage.
- Retrieve plain/synchronized lyrics from LRCLIB.
- Probe downloaded media duration with ffprobe.
- Return metadata suitable for a SongAsset manifest.

## What it does not do yet

- source separation is not enabled in this first slice;
- melody extraction is not enabled;
- it does not expose a cloud media library;
- it does not bundle copyrighted media in the repository.

## Legal/usage boundary

Downloads must be limited to media the user is authorized to access and process, and integrations must respect the terms of the source service.

## Why a worker exists

A browser/PWA cannot reliably execute arbitrary native binaries such as yt-dlp/ffmpeg on every Android/iOS browser. The worker is therefore an optional processing node. A future native mobile runtime can implement the same worker contract locally.
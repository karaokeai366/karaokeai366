# KaraokeAI Media Worker

Optional local worker for media discovery and preparation.

## What it does now

- Search music catalog metadata and return title, artist, album, duration, thumbnail and source.
- Download an explicitly selected source URL to the worker's local storage.
- Normalize the selected media to a processing WAV.
- Retrieve plain/synchronized lyrics from LRCLIB and write `lyrics.lrc` / `lyrics.json`.
- Separate vocals and instrumental with the installed source-separation adapter.
- Analyze the vocal stem with pYIN to generate a time-based melody reference.
- Estimate BPM and an initial musical key.
- Write a portable `manifest.json` with artifact URLs and SHA-256 integrity entries.
- Expose the generated SongAsset files below `/media/{assetId}/...`.

## Preparation result

A successful `POST /prepare` produces a SongAsset folder containing, when available:

- the original downloaded media;
- `mix.wav` as the normalized processing source;
- `vocals.wav`;
- `instrumental.wav`;
- `lyrics.lrc` and `lyrics.json`;
- `melody.json`;
- a downloaded cover image;
- `manifest.json`.

Lyrics may be missing when no matching catalog entry is available. The core preparation still requires valid vocal, instrumental and melody artifacts before the session marks the queue entry as ready.

## What it does not do yet

- fine-grained lyric alignment fallback when synchronized lyrics are unavailable;
- advanced melody cleanup and phrase segmentation;
- cloud media library;
- it does not bundle copyrighted media in the repository.

## Legal/usage boundary

Downloads must be limited to media the user is authorized to access and process, and integrations must respect the terms of the source service.

## Why a worker exists

A browser/PWA cannot reliably execute arbitrary native binaries such as yt-dlp/ffmpeg on every Android/iOS browser. The worker is therefore an optional processing node. A future native mobile runtime can implement the same worker contract locally.
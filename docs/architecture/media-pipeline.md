# Media Pipeline

## Current flow

```text
Search -> select result -> authorized source URL -> media worker
                                      |
                                      +-> original media
                                      +-> duration
                                      +-> LRCLIB lyrics
                                      |
                                      +-> SongAsset manifest (next)
```

`yt-dlp` currently supports search through `ytsearch:` and structured metadata output. It is pinned here to the stable 2026.08.19 release at the time of this implementation. See the upstream project for current extractor/format behavior. cite not valid here

LRCLIB exposes `/api/get` and `/api/search`, and its documentation asks clients to throttle requests and identify themselves. The worker uses `/api/get` first and treats 404 as 'lyrics not found'.

## Next stages

1. Generate an immutable SongAsset manifest.
2. Normalize audio.
3. Source separation adapter (Demucs/UVR family).
4. Melody/reference extraction.
5. Key detection and transposition metadata.
6. Make the resulting artifact portable between participant nodes.
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

## Key transposition

After a SongAsset is ready, the owner or Host can select another musical key before playback.

The worker exposes `POST /transpose-key`. The selected target is normalized to a pitch class and the shortest semitone interval from the detected original key is used.

To avoid cumulative quality loss, the worker stores:
- `instrumental.base.wav` as the immutable transposition source;
- `melody.base.json` as the immutable reference source.

Each new target key is generated from those base artifacts, and the manifest updates `selectedKey` plus the integrity hashes.

The instrumental keeps its duration while its pitch is shifted. The melody reference receives the exact same semitone offset, so scoring compares the singer against the reference in the selected key.

## Browser microphone requirement

The browser microphone path uses `getUserMedia()` and therefore requires a secure context. In the web/PWA build, use HTTPS or a local loopback origin such as `localhost`; ordinary HTTP over a LAN IP is not sufficient for microphone permission in browsers.

The WebRTC transport remains local-first. A STUN server can be supplied with `VITE_WEBRTC_STUN_URL` when sessions need candidate discovery beyond simple local-network connectivity.

## Legal/usage boundary

Downloads must be limited to media the user is authorized to access and process, and integrations must respect the terms of the source service.

## Why a worker exists

A browser/PWA cannot reliably execute arbitrary native binaries such as yt-dlp/ffmpeg on every Android/iOS browser. The worker is therefore an optional processing node. A future native mobile runtime can implement the same worker contract locally.
## YouTube e autenticação

O worker suporta um arquivo de cookies no formato Netscape para fontes que exigem autenticação ou apresentam desafios anti-bot. O arquivo **não deve ser versionado**.

Defina:

```text
KARAOKE_YOUTUBE_COOKIES_FILE=/run/secrets/youtube-cookies.txt
```

No Docker, monte o arquivo exportado no caminho correspondente como somente leitura. Para execução nativa, a variável pode apontar diretamente para o arquivo local.

O arquivo de cookies deve ser obtido pelo próprio usuário de uma sessão autorizada e tratado como credencial: não publique no GitHub, não coloque no `.env` versionado e não o envie para o frontend.

O endpoint `/health` informa `youtube_cookies_configured` separadamente de `youtube_ready`. Assim, é possível distinguir dependências do yt-dlp/EJS/Deno de uma configuração de autenticação ausente.

Se o Chrome do Windows apresentar erro de DPAPI dentro do worker Docker, não tente compartilhar o perfil do Chrome com o container. Exporte os cookies para um arquivo compatível e monte somente esse arquivo no worker.

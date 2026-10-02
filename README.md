# KaraokeAI 🎤

KaraokeAI is a distributed, local-first karaoke platform designed for Android, iOS, browsers and Smart TVs.

The project is built around one idea: **the host coordinates the session, while participating devices contribute processing, audio capture and media playback whenever possible.**

## Core goals

- Android and iOS through a shared web/PWA client.
- First device starts as the session host.
- Host remains in control and must approve voluntary host transfers.
- The system can recommend a better host based on device health/capacity, without taking control away from the host.
- Processing is distributed across participant devices when practical.
- Songs are prepared locally: instrumental, lyrics, synchronization and reference melody.
- Each singer can use their own phone as a microphone.
- WebRTC is the target transport for low-latency real-time audio/data.
- Smart TV acts primarily as the visual stage.
- Shared queue with ownership: participants can remove only their own queue entries; host can moderate the whole queue.
- Evaluation has a clear start, performance and end.
- A session/round can define how many songs contribute to the final score.
- A singer may restart a song only before 50% progress and only while restart credits remain for the current round.
- Restarted attempts do not contribute to the official score.
- The singer may transpose the song to a comfortable key before or when restarting, and scoring follows the selected key.
- Party-scale sessions must support many participant phones; the initial scale target is 50 active participants, with a configurable capacity up to 100.

## Project principles

1. **Local-first**
2. **Peer-assisted / distributed processing**
3. **Host-controlled orchestration**
4. **Low-latency audio**
5. **Privacy by default**
6. **Platform agnostic**
7. **Modular AI processing**
8. **Clear and friendly UX**

## Planned stack

- Frontend: React + TypeScript + Vite + PWA
- Real-time control: WebSocket/SignalR-compatible protocol
- Real-time audio: WebRTC
- Host/session engine: initially browser/PWA compatible, with a path to a native wrapper when required by platform restrictions
- Local persistence: IndexedDB
- Optional local database / native storage: platform-dependent adapter
- Media processing: FFmpeg
- AI adapters: Demucs/UVR-compatible source separation, Whisper/WhisperX-compatible lyrics alignment, pitch detection/scoring adapters
- Optional future native wrapper: Capacitor
- Optional future desktop/server node: .NET

## High-level architecture

```text
                         KARAOKE SESSION
                                |
                       +--------+--------+
                       |                 |
                    HOST NODE         TV / STAGE
                       |                 |
               session coordination    visual UI
                       |
          +------------+-------------+
          |            |             |
        phone        phone         phone
        worker       worker        worker
          |            |             |
       download     download     download
       prepare      prepare      prepare
          |            |             |
          +------------+-------------+
                       |
                    WebRTC
                       |
                 real-time audio
                       |
                    Audio out
```

## Repository layout

```text
/
├── apps/
│   ├── mobile/
│   ├── tv/
│   └── web/
├── packages/
│   ├── protocol/
│   ├── session/
│   ├── queue/
│   ├── scoring/
│   ├── lyrics/
│   ├── media/
│   └── audio/
├── workers/
│   ├── media-prep/
│   └── scoring/
├── docs/
│   ├── architecture/
│   ├── product/
│   └── decisions/
└── README.md
```

## Important legal/operational boundary

The repository contains application code and processing logic, not copyrighted music libraries. Integrations must respect the rights, terms and licenses applicable to any external media source.

## Current status

**Phase 1 — distributed session foundation**

The signaling/session foundation now includes participant presence and reconnect, Host transfer/recovery, server-side automatic queue advancement and granular session settings updates. The next development focus is completing the party-scale multi-participant model and the remaining karaoke pipeline, scoring and round features before full real-device testing.

See GitHub Issue #9 for the multi-participant scale work and the architecture notes in `docs/architecture/multi-participant-scale.md`.

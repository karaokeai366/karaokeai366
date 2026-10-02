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
- Party-scale sessions support many participant phones; the initial scale target is 50 active participants, with a configurable capacity up to 100.

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
- Real-time control: WebSocket
- Real-time audio: WebRTC
- Host/session engine: browser/PWA compatible, with a path to a native wrapper when required by platform restrictions
- Local persistence: IndexedDB
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

## Party-scale session rules

- Default active-participant capacity: **50**.
- Configurable capacity: **2–100**.
- TV clients do not consume participant slots.
- Offline participants keep their identity but do not consume an active slot.
- Default queue limit: **3 active songs per participant**.
- The server selects the next singer using deterministic fairness rules rather than a two-device assumption.
- Only the current singer needs the real-time microphone/media path; queue membership does not create an audio stream.
- Incremental `session.event` messages carry ordered sequence numbers; snapshots remain available for initial synchronization and recovery.
- `LEGACY_SNAPSHOT_BROADCAST` defaults to `true` during the migration so the existing web client remains compatible. It can be disabled after event consumption is enabled throughout the clients.

### Signaling environment

```text
PORT=8787
DEFAULT_SESSION_CAPACITY=50
MAX_SONGS_PER_PARTICIPANT=3
LEGACY_SNAPSHOT_BROADCAST=true
```

The signaling service now runs `src/serverPartyReady.ts` by default and retains the existing WebSocket message names used by the web client.

## Local test

Start the signaling service:

```bash
npm --prefix apps/signaling install
npm --prefix apps/signaling run dev
```

In another terminal, start the web application:

```bash
npm --prefix apps/web install
npm --prefix apps/web run dev
```

The web client defaults to WebSocket port `8787`. To use another host/port, set `VITE_SIGNALING_URL` in the web environment.

For a first party test, create one Host session, join from several phones, then progressively test 5, 10, 20 and 30 devices before attempting 50. The server enforces the configured participant limit.

## Important legal/operational boundary

The repository contains application code and processing logic, not copyrighted music libraries. Integrations must respect the rights, terms and licenses applicable to any external media source.

## Current status

**Phase 1 — party-scale session foundation: ready for functional testing**

The signaling/session foundation now covers participant presence and reconnect, configurable capacity, Host transfer/recovery, per-participant queue limits, deterministic fair queue selection, automatic queue advancement, round state, restart limits, performance lifecycle, score submission, granular session events and legacy snapshot recovery.

The project is now at the point where real-device functional testing can begin. The next validation stage is not a new two-phone feature pass; it is progressive party testing at 5 → 10 → 20 → 30 → 50 participants, followed by disabling legacy full-snapshot broadcasts after all clients consume incremental events reliably.

See GitHub Issue #9 for the multi-participant scale work and the architecture notes in `docs/architecture/multi-participant-scale.md` and `docs/architecture/party-queue.md`.

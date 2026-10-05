# KaraokeAI 🎤

KaraokeAI is a distributed, local-first karaoke platform designed to run first as a **React + TypeScript + Vite/PWA client** on phones and Smart TVs. The same `apps/web` application currently provides the Host, participant and TV roles; native Android/iOS wrappers remain future targets.

The core idea is simple: **the Host coordinates the party, the TV is the visual stage, and participant phones contribute microphone capture and media processing when needed.**

## Current implementation status

The repository currently has one runnable frontend application: `apps/web`. It can operate as **Host, participant, or TV** through the same PWA codebase. `apps/mobile` and `apps/tv` are architectural targets, not separate runnable applications yet.

The party signaling server, shared protocol and web client are aligned around the same session model. CI now checks compilation plus an end-to-end signaling smoke test covering host creation, participant/TV join, queue insertion, preparation, singer selection, performance start/finish and scoring.

Real-device validation is still a separate stage: browser permissions, WebRTC behavior, TV playback, media assets, Wi-Fi conditions and 1/10/20/30/50-device load must be exercised on actual hardware before production use.

## Server ↔ Web parity

| Capability | Signaling | Web/PWA |
|---|---:|---:|
| Create/join/reconnect session | ✅ | ✅ |
| Snapshot synchronization/recovery | ✅ | ✅ |
| Ordered incremental `session.event` | ✅ | ✅ |
| Sequence-gap recovery | ✅ | ✅ |
| Participant join/leave/update | ✅ | ✅ |
| Capacity 1–50, default 50 | ✅ | ✅ state + commands |
| TV excluded from participant capacity | ✅ | ✅ |
| Host transfer | ✅ | ✅ command facade + state |
| Host recovery/claim | ✅ | ✅ command facade + state |
| Shared queue | ✅ | ✅ |
| Per-participant queue limit | ✅ default 3 | ✅ server-enforced + state |
| Queue add/remove/update | ✅ | ✅ |
| Deterministic fair next singer | ✅ | ✅ local state consumption; server remains authoritative |
| Automatic queue advancement | ✅ | ✅ state consumption |
| Song preparation progress | ✅ | ✅ |
| Original/selected key | ✅ | ✅ |
| Playback pause/resume/skip/end | ✅ | ✅ command facade + state |
| Performance start/pause/resume/end | ✅ | ✅ event reducer/state |
| Restart before 50% with credits | ✅ | ✅ policy/UI foundation |
| Performance scoring | ✅ | ✅ scoring engine + submission |
| Round modes (`open` / fixed songs) | ✅ | ✅ state + command facade |
| Round completion | ✅ | ✅ state consumption |
| WebRTC microphone foundation | ✅ signaling | ✅ browser foundation |
| Pitch detection/scoring | — | ✅ |
| Automatic key suggestion | — | ✅ |
| TV visual-stage role | ✅ | ✅ same web app |

## Party-scale rules

- Default active-participant capacity: **50**.
- Configurable capacity: **1–50**.
- TV clients do not consume participant slots.
- Offline participants keep their identity but do not consume an active slot.
- Default queue limit: **3 active songs per participant**.
- The server chooses the next singer using deterministic fairness rules rather than a two-device assumption.
- Queue membership does **not** create an audio stream.
- Only the current singer needs the real-time microphone/media path.
- Incremental `session.event` messages carry an ordered sequence number.
- A client that detects a sequence gap requests a full snapshot for recovery.
- Legacy full snapshots remain enabled during migration for safe compatibility.

## Protocol

Client commands include:

```text
session.create
session.join
session.reconnect
session.state.request
session.settings.set
host.claim
host.transfer
queue.add
queue.remove
queue.status.set
queue.next
queue.restart
playback.finished
playback.control
performance.complete
round.configure
```

Server-side incremental events include:

```text
participant.joined
participant.left
participant.updated
host.changed
queue.added
queue.updated
queue.removed
queue.next
singer.called
performance.started
performance.paused
performance.resumed
performance.finished
performance.scored
round.updated
session.settings.changed
```

## Architecture

```text
                         KARAOKE PARTY
                              │
                 ┌────────────┴────────────┐
                 │                         │
              SIGNALING                  TV/PWA
                 │                         │
        session + queue + events      visual stage
                 │
      ┌──────────┼──────────┐
      │          │          │
   phone #1   phone #2   phone #N ... phone #50
      │          │          │
   control    control    control
   + mic      + mic      + mic
      │          │          │
      └──────────┴──────────┘
                 │
        current singer only
                 │
              WebRTC
                 │
             audio out
```

### Snapshot + event model

```text
new connection / recovery
          │
          ▼
   session.state snapshot
          │
          ▼
 ordered session.event #1
          │
          ▼
 ordered session.event #2
          │
          ▼
 ordered session.event #N

if a sequence gap is detected:
          │
          ▼
   request session.state
```

This avoids sending a complete session snapshot for every queue or performance change while retaining a reliable recovery path.

## Repository layout

```text
/
├── apps/
│   ├── web/                 # current runnable PWA: Host / participant / TV
│   ├── signaling/           # party WebSocket server
│   └── media-worker/        # media preparation worker
├── packages/
│   ├── protocol/            # WebSocket message contracts
│   ├── session/             # session state, events, fairness, rounds
│   ├── media/               # media/search/preparation contracts
│   ├── scoring/             # scoring foundations
│   ├── lyrics/
│   └── audio/
├── docs/
│   ├── architecture/
│   ├── product/
│   └── decisions/
└── README.md
```

## Signaling environment

```text
PORT=8787
DEFAULT_SESSION_CAPACITY=50
MAX_SONGS_PER_PARTICIPANT=3
LEGACY_SNAPSHOT_BROADCAST=true
```

The signaling service runs `src/serverPartyReadyV2.ts` by default.

## Local development

### 1. Signaling

```bash
npm --prefix apps/signaling install
npm --prefix apps/signaling run dev
```

### 2. Web/PWA

```bash
npm --prefix apps/web install
npm --prefix apps/web run dev
```

The web client defaults to WebSocket port `8787`. Use `VITE_SIGNALING_URL` to point it at another signaling host/port.

### 3. Media worker

The media worker has its own Python environment and compile check. See `apps/media-worker/` for its current runtime instructions.

## Automated smoke test

The signaling application includes an end-to-end smoke test:

```bash
npm --prefix apps/signaling run build
npm --prefix apps/signaling run dev
# in another terminal
npm --prefix apps/signaling run smoke
```

The CI workflow starts the built signaling server and runs the smoke test automatically. It verifies the core party path without requiring physical devices.

## Recommended real-device test progression

Do not jump directly to 50 phones. Validate the complete flow progressively, starting with the minimum valid party:

```text
1 phone (Host)
        ↓
2 phones
        ↓
5 phones
        ↓
10 phones
        ↓
20 phones
        ↓
30 phones
        ↓
50 phones
```

The Host phone counts as one active participant. A TV does not consume a participant slot.

At each level validate:

1. create/join/reconnect;
2. participant presence;
3. add/remove songs;
4. per-user queue limit;
5. fair next singer;
6. preparation and selected key;
7. singer call;
8. microphone/WebRTC;
9. playback controls;
10. automatic completion;
11. scoring;
12. restart policy;
13. round completion;
14. Host transfer/recovery;
15. TV synchronization;
16. event-loss recovery through snapshots.

## CI/build gate

Every implementation change must pass all repository checks before being treated as complete:

```text
web
 ├─ npm run typecheck
 └─ npm run build

signaling
 ├─ npm run build
 └─ npm run smoke

media-worker
 └─ python -m compileall -q src
```

The smoke test is intentionally independent of browser UI so a green CI result means the signaling protocol is executable, not merely type-correct.

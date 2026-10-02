# KaraokeAI 🎤

KaraokeAI is a distributed, local-first karaoke platform designed to run first as a **React + TypeScript + Vite/PWA client** on phones and Smart TVs, with the architecture prepared for native Android/iOS wrappers later.

The core idea is simple: **the Host coordinates the party, the TV is the visual stage, and participant phones contribute microphone capture and media processing when needed.**

## Current implementation status

The repository currently has one runnable frontend application: `apps/web`. It can operate as **Host, participant, or TV** through the same PWA codebase. `apps/mobile` and `apps/tv` are architectural targets, not separate runnable applications yet.

The signaling server is now party-oriented and supports the complete session lifecycle exposed by the protocol. The web client contains the corresponding typed command facade, incremental-event reducer/cursor, queue/media preparation, scoring, restart and WebRTC foundations. The remaining work is UI/UX completion and real-device validation of every flow; this README intentionally does not claim that those flows have already been field-tested.

## What the server exposes and what the web client supports

| Capability | Signaling server | Web/PWA client |
|---|---:|---:|
| Create/join/reconnect session | ✅ | ✅ |
| Snapshot synchronization/recovery | ✅ | ✅ |
| Ordered incremental `session.event` | ✅ | ✅ |
| Participant join/leave/update | ✅ | ✅ |
| Capacity 2–100, default 50 | ✅ | ✅ state + validation |
| TV excluded from participant capacity | ✅ | ✅ |
| Host transfer | ✅ | ✅ command facade + state |
| Host recovery/claim | ✅ | ✅ command facade + state |
| Shared queue | ✅ | ✅ |
| Per-participant queue limit | ✅ default 3 | ✅ server-enforced + state |
| Queue add/remove/update | ✅ | ✅ |
| Deterministic fair next singer | ✅ | ✅ state consumption |
| Automatic queue advancement | ✅ | ✅ state consumption |
| Song preparation progress | ✅ | ✅ |
| Key/original/selected key | ✅ | ✅ |
| Playback pause/resume/skip/end | ✅ | ✅ command facade + state |
| Performance start/pause/resume/end | ✅ | ✅ incremental events |
| Restart before 50% with credits | ✅ | ✅ policy + UI foundation |
| Performance scoring | ✅ | ✅ scoring engine + submission |
| Round modes (`open` / fixed songs) | ✅ | ✅ state + command facade |
| Round completion | ✅ | ✅ state consumption |
| WebRTC microphone foundation | ✅ signaling support | ✅ browser foundation |
| Pitch detection/scoring | — | ✅ |
| Automatic key suggestion | — | ✅ |
| TV visual-stage role | ✅ session role | ✅ same web app |

## Party-scale rules

- Default active-participant capacity: **50**.
- Configurable capacity: **2–100**.
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

The signaling service runs `src/serverPartyReady.ts` by default.

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

## Recommended test progression

Do not jump directly to 50 phones. Validate the complete flow progressively:

```text
1 Host + 1 participant
        ↓
5 participants
        ↓
10 participants
        ↓
20 participants
        ↓
30 participants
        ↓
50 participants
```

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

Every implementation change must pass all three repository checks before being treated as complete:

```text
web
 ├─ npm run typecheck
 └─ npm run build

signaling
 └─ npm run build

media-worker
 └─ python -m compileall -q src
```

A green build is necessary but not sufficient for declaring the product functionally ready: real-device WebSocket/WebRTC/media tests are still required.

## Architecture documentation

Key documents:

- `docs/architecture/multi-participant-scale.md`
- `docs/architecture/session-events.md`
- `docs/architecture/session-scale-implementation.md`
- `docs/architecture/party-queue.md`

## Legal/operational boundary

The repository contains application and processing code, not copyrighted music libraries. Any external media integration must respect the applicable rights, terms and licenses.

## Current milestone

**Party-scale foundation → integration and functional validation.**

The server and shared protocol now model the full party lifecycle. The web/PWA client is being brought into parity with those server capabilities. The next milestone is a green CI run for the current integration, followed by end-to-end testing at increasing participant counts. Only after those tests pass should legacy full-snapshot broadcasting be disabled.

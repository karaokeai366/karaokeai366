# Session event protocol

KaraokeAI keeps a complete `session.state` snapshot for initial synchronization and recovery, while normal mutations can be represented as incremental `session.event` messages.

## Event flow

```text
client connects/reconnects
        |
        v
  full session.state
        |
        +---- event 101 ---->
        +---- event 102 ---->
        +---- event 103 ---->
        |
        v
  local event reducer
```

## Event categories

### Presence
- `participant.joined`
- `participant.left`
- `participant.updated`
- `host.changed`

### Queue
- `queue.added`
- `queue.updated`
- `queue.removed`
- `queue.next`

### Performance
- `singer.called`
- `performance.started`
- `performance.paused`
- `performance.resumed`
- `performance.finished`
- `performance.scored`

### Session
- `round.updated`
- `session.settings.changed`

## Why snapshots and events coexist

Snapshots are the recovery boundary. Events are the efficient steady-state transport. This avoids requiring a client to receive every event since the session began and allows reconnect to restore a consistent state without replaying an unbounded event log.

## Migration rule

`session.state` remains available while clients migrate. New high-frequency flows should publish a small event payload first; a full state request is used only for initial synchronization, reconnect, recovery, or when a client detects an event gap.

Every event has a unique `eventId` and timestamp. Clients should retain the last processed event ID/sequence for the session and ignore duplicates.

## Audience

Events may be broadcast to all connected clients, restricted to selected participant IDs, or restricted by role. This is important for party scale: a singer-specific preparation update should not force every phone to process the same payload.

The TV remains a first-class role and is not counted as a participant capacity slot.

## Current implementation boundary

`packages/session/src/sessionEvents.ts` defines the transport-neutral event contract. `apps/signaling/src/sessionEventTransport.ts` emits targeted events, and `packages/session/src/applySessionEvent.ts` applies supported incremental events to a local snapshot.

The signaling server still uses full snapshots for several mutations. The next integration step is to emit incremental events alongside those snapshots, validate both paths, and only then remove full broadcasts from high-frequency mutations.

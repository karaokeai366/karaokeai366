# Session event protocol

The signaling layer currently sends `session.state` snapshots for compatibility. The next transport evolution uses domain events so clients can process only the changes relevant to them.

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

## Migration rule

`session.state` remains available while clients migrate. New high-frequency flows should publish a small event payload first; a full state request is used only for initial synchronization, reconnect, recovery, or when a client detects an event gap.

Every event has a unique `eventId` and timestamp. Clients should retain the last processed event ID/sequence for the session and ignore duplicates.

## Audience

Events may be broadcast to all connected clients, restricted to selected participant IDs, or restricted by role. This is important for party scale: a singer-specific preparation update should not force every phone to process the same payload.

The TV remains a first-class role and is not counted as a participant capacity slot.

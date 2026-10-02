# Session scale implementation

## Current model

The signaling layer keeps a full `session.state` snapshot for creation, reconnect and recovery. Incremental events are defined separately so the normal path can move away from full snapshots without losing a recovery mechanism.

## Ordered events

Each `session.event` carries:

- `eventId`: unique event identity;
- `sequence`: monotonically increasing sequence within the session;
- `sessionId`: session ownership boundary;
- `type`: typed domain event;
- `audience`: optional targeted delivery;
- `actorParticipantId`: optional actor;
- `payload`: event-specific data.

Clients track the last processed sequence. A duplicate or old event is ignored. A gap causes the client to request/recover from a full snapshot before continuing normal incremental processing.

## Audience model

Events can target:

- all connected clients;
- Host only;
- TV/stage only;
- participant devices;
- explicit participant IDs;
- a target with exclusions.

The intended rule is that a client should receive the smallest event audience that still keeps its UI correct.

## Migration order

1. Keep snapshot delivery for compatibility and recovery.
2. Emit participant join/leave events alongside snapshots.
3. Consume those events on the web client and validate convergence.
4. Migrate queue add/update/remove.
5. Migrate singer/playback/performance events.
6. Measure traffic and event fanout at 10, 20, 30 and 50 active participants.
7. Remove redundant full snapshots from high-frequency mutation paths only after convergence and recovery are verified.

## Important media rule

Participant scale must not imply one media stream per participant. The control plane can have many connected phones, while the media plane should normally establish a real-time microphone path only for the current singer.

## Scale targets

- 10: baseline party
- 20: normal party
- 30: large party
- 50: primary MVP target
- 100: upper configurable capacity, requiring explicit capacity/load validation

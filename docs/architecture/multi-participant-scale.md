# Multi-participant session scale

KaraokeAI is designed for a party-style karaoke session, not a two-device-only interaction.

## Capacity model

- Default session capacity: 50 active participant devices.
- Configurable capacity range: 2–100 participants.
- The TV/stage connection does not consume a participant slot.
- Offline participants remain part of the session identity but do not consume an active connection slot.
- A reconnect restores the existing participant identity instead of creating a new participant.

## Roles

A session contains one Host, zero or more participant devices, and optionally one or more TV/stage clients. The number of participants must never be encoded as a fixed pair such as `host + singer`.

The current singer is a state of the queue entry, not a special second participant role.

## Control-plane scaling

Participant devices use the signaling/control channel for small state and command messages. Only the currently performing singer needs a real-time microphone/media path.

The architecture must avoid creating one WebRTC audio path per participant merely because many phones are connected to the party.

## Queue fairness

Automatic advancement considers completed songs per participant and prefers a different singer from the most recent owner when candidates are tied. This keeps a large party from being dominated by one participant with a large queue.

## Planned scaling refinement

The current signaling implementation broadcasts complete session snapshots. This is acceptable while establishing the MVP, but larger sessions should progressively move high-frequency updates to targeted events/deltas so that queue or playback changes do not require every client to process an entire session snapshot.

The first explicit scale targets are 10, 20, 30 and 50 active participants.

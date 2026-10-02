# Party queue policy

The queue is designed for many participants, not a Host + one singer model.

## Default behavior

- A participant may have up to 3 queued songs by default.
- The limit is a policy, not a hard-coded UI assumption.
- The Host may moderate the queue.
- Participants may manage their own entries according to session permissions.
- The next singer is selected fairly from eligible participants.

## Fairness

The baseline selector considers:

1. number of completed songs;
2. least-recently played participant;
3. the previous singer, to avoid immediate repetition when alternatives exist;
4. current queued-song count;
5. queue insertion time as a stable tie-breaker.

This is intentionally a deterministic domain policy so the same decision can be reproduced in tests and, eventually, enforced by the signaling server.

## Scale targets

The queue must remain correct for 10, 20, 30 and 50 participants. A participant adding multiple songs must not starve participants who have fewer songs in the queue.

## Media rule

Queue membership does not imply an audio connection. Only the current performer requires the real-time microphone/media path.

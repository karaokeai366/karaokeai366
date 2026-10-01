# Product Vision

## One sentence

KaraokeAI is a local-first, distributed karaoke game in which phones cooperate to prepare songs, capture singers' microphones and evaluate performances while a host coordinates the session and a TV presents the show.

## Session lifecycle

1. A device creates a session and becomes the initial host.
2. A QR code / session link allows participants to join.
3. Each participant gets an identity and permissions.
4. Songs are searched/selected and assigned to the requesting participant.
5. The requesting device prepares the song whenever possible.
6. The shared queue is updated in real time.
7. The host controls playback/session state.
8. The singer selects a comfortable key.
9. The performance begins.
10. The singer can restart only while:
   - the song is at or below 50% progress, and
   - the round still has restart credits.
11. A completed attempt is evaluated.
12. The result is sealed at the end of the song.
13. The session/round aggregates the configured number of songs.
14. The final round score is published.

## Evaluation model

Evaluation is intentionally separated from live performance UX.

During the song:
- show lyrics and performance information;
- do not require the singer to watch live score changes.

At the end:
- calculate and seal the song score;
- show the result;
- update the round aggregate.

## Round configuration

The host decides how many songs count toward the final score.

Examples:
- 1 song
- 3 songs
- 5 songs
- 10 songs
- custom count
- open-ended until the host ends the round

The scoring engine must not assume a fixed number.

## Restart credits

Restart credits are scoped to the current round and participant.

Baseline business rule:
- 1 song: 1 restart
- 2 songs: 1 restart
- 3 songs: 2 restarts
- 4 songs: 2 restarts
- 5+ songs: approximately 30% of song count, with at least 1

The formula must live in a configurable policy module so it can evolve without rewriting queue/session logic.

A restart after the 50% point is not allowed.

## Key transposition

Each participant may choose a key for their performance.

The reference melody and scoring target are transposed to that key.

Changing the key must not itself penalize or reward the singer.

## Host policy

- First device: initial host.
- Host transfer: always explicit and confirmed by current host.
- System may recommend alternative hosts based on device health/capacity.
- Host may select a different participant or remain host.
- Unexpected host loss may trigger a controlled recovery using the best prepared backup node.

## Distributed work

A device may advertise capabilities:
- CPU concurrency
- available memory hints
- battery status
- thermal/health signal where available
- network quality
- storage availability
- measured short benchmark
- current load

These signals are recommendations, not absolute benchmarks.

Tasks may include:
- media download
- media preprocessing
- audio feature extraction
- pitch analysis
- temporary relay/worker duties

The host primarily coordinates the session state.

## Queue ownership

Each queue entry has an owner participant.

Participants:
- can add songs;
- can reorder only where policy allows;
- can delete only their own entries.

Host:
- can moderate the entire queue.

Authorization is enforced by the session engine, not only by the UI.

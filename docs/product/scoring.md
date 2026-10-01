# Scoring Engine

## Goal

Evaluate a completed karaoke performance against the selected key and timing reference.

## Core dimensions

Initial engine targets:
- pitch accuracy
- note precision
- timing/rhythm
- note stability

Future optional dimensions:
- phrase timing
- dynamics
- vibrato consistency
- pronunciation / lyric timing

## Important rule

The official score is created only after a performance is complete.

A live visualizer can show pitch guidance, but the official score remains sealed at the performance end.

## Key transposition

If the source key is K and the singer selects K', the reference note sequence is shifted by the corresponding semitone delta.

Scoring compares:
```text
detected singer pitch
vs
transposed target pitch
```

## Restarts

Restarted attempts are marked:
```text
cancelled = true
official = false
```

Only the completed official attempt contributes to the score.

## Round aggregation

The round stores individual sealed song scores and computes a final score only when the host-defined song count is satisfied.

The exact aggregation algorithm should remain configurable.


## Automatic key test

During the early part of a performance, the singer's local pitch samples may be analyzed for a sustained semitone offset against the current reference.

If the signal is consistent enough, KaraokeAI can suggest a nearby key. The suggestion is advisory and requires explicit singer confirmation.

Accepting the suggestion starts a new test in the selected key and does not consume a restart credit. Rejecting it keeps the current key. The singer can also choose another key manually or return to the immediately previous key.

The first attempt is not scored when a key test is accepted. Only the final completed presentation in the selected key becomes eligible for the official score.

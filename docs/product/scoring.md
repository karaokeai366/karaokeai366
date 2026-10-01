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

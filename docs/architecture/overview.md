# Architecture Overview

## Design target

A browser/PWA-first system that can run with no permanent central server for a local session.

## Nodes

### Host node
Responsible for:
- session authority
- participant membership
- queue state
- permissions
- playback state
- round state
- host transfer coordination

### Participant node
May provide:
- user controls
- microphone capture
- local media preparation
- local scoring
- worker capacity
- media playback/relay

### TV node
Responsible for:
- lyrics
- current singer
- current song
- round status
- result/reveal UI
- QR code / session join UI

## Control plane

Use an authoritative replicated session state.

Conceptual objects:
- Session
- Participant
- Device
- QueueEntry
- SongAsset
- Round
- Performance
- Score
- HostTransfer

A real implementation can use WebSocket/SignalR semantics for rapid state propagation.

## Media plane

Prefer WebRTC for live low-latency audio.

Possible flows:

### Local preparation
```text
source -> participant device -> local processing -> SongAsset
```

### Singer microphone
```text
microphone -> WebRTC -> selected audio sink/mixer
```

### TV
```text
session state -> TV browser
media stage -> TV
```

## Distributed processing

Workers announce capabilities and current availability.

Tasks are assigned to a specific node and produce immutable artifacts.

Example:
```text
Song request
  -> download
  -> normalize
  -> source separation
  -> lyrics lookup
  -> lyrics alignment
  -> melody extraction
  -> artifact bundle
```

## Artifact bundle

A prepared song should have a portable manifest:

```text
song/
  manifest.json
  instrumental.*
  vocals.*
  lyrics.lrc
  lyrics.json
  melody.json
  cover.*
```

The exact media formats remain an implementation decision.

## Fault tolerance

The host should maintain enough replicated session state to hand off control.

Voluntary transfer:
1. current host selects target;
2. target acknowledges readiness;
3. state snapshot is synchronized;
4. target becomes host;
5. former host becomes participant.

Unexpected host loss:
1. peers detect host timeout;
2. last prepared backup candidates are ranked;
3. session recovery starts;
4. new host is announced.

This mechanism is deliberately separate from the voluntary transfer flow.

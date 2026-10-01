# Signaling Service

## Purpose

The signaling service is intentionally small.

It is **not**:
- a music server;
- an AI server;
- a media relay;
- the session's long-term data store.

Its initial purpose is to help browsers establish the real-time peer/session topology when a PWA cannot directly expose a LAN server on the target platform.

## Responsibilities

- create a session endpoint;
- accept participants;
- deliver authoritative state from the Host;
- forward small session commands;
- notify peers when a participant connects/disconnects.

## Media boundary

Large media and real-time microphone audio must not be routed through this service.

The target media plane is WebRTC.

## Local deployment

For development or a home network, the signaling component can run as the only central process:

```text
docker compose up --build
```

The browser connects to port 8787.

## Future direction

When native host runtimes are introduced, the signaling role may be embedded in the selected host device and the external service omitted for a fully local session.

# MVP-001: Session Bootstrap

## Implemented

The first web/PWA slice now provides:

- participant name capture;
- local device identity;
- host session creation;
- session ID;
- join URL generation;
- QR Code rendering;
- participant capability hints;
- responsive host dashboard;
- Android/iOS-friendly touch UI.

## Deliberate limitation

This slice does **not** yet claim cross-device synchronization. The browser can render the invitation and persist local state, but a browser/PWA cannot by itself expose an HTTP/WebSocket server to other devices in the same LAN on all target platforms.

The next networking slice must introduce the real session transport and WebRTC signaling path while keeping the host authoritative.

## Why this is intentional

The product requires Android, iOS and Smart TV support. We want to avoid hard-coding a platform-specific server before the session protocol and transport boundaries are stable.

## Next networking target

1. Define session messages.
2. Add transport abstraction.
3. Add signaling implementation.
4. Establish peer connections.
5. Replicate authoritative host state.
6. Verify two phones + one TV in a real LAN.

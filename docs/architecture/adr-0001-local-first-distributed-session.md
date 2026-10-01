# ADR-0001: Local-first distributed session

## Status

Accepted

## Context

The application must work across Android and iOS, ideally without requiring a dedicated powerful server. The host should coordinate the session while participant devices can contribute processing.

## Decision

Use a local-first distributed architecture with:
- one authoritative host session;
- participant nodes with optional worker duties;
- WebRTC for live media paths;
- browser/PWA as the primary client surface;
- portable song artifacts for handoff and reuse.

## Consequences

### Positive
- reduced load on a single machine;
- no mandatory cloud dependency during a prepared session;
- works naturally with multiple participant devices;
- enables graceful host transfer.

### Negative
- synchronization and peer discovery are more complex;
- iOS background execution constraints require care;
- browser capability differences must be detected at runtime;
- live audio latency requires focused engineering.

## Rejected alternative

A single centralized media/AI server was not chosen as the primary architecture because it creates a single performance bottleneck and conflicts with the goal of running with modest hardware.

# @karaokeai/protocol

Transport-independent session protocol.

The host is authoritative for session state. Clients send commands; the host validates them and publishes state/events.

Initial message families: session.hello, session.join.request, session.join.accepted, session.state, queue.add, queue.remove, round.configure, round.start, performance.start, performance.restart.request, performance.complete, host.transfer.request, host.transfer.accepted.

Large media payloads must not use the control plane.
# @karaokeai/session

Domain/state engine for the karaoke session.

Responsibilities:
- participant identity and roles;
- host authority;
- queue ownership;
- round rules;
- restart credit calculation;
- performance lifecycle;
- score aggregation;
- host transfer policy.

Transport adapters call the domain engine; the domain engine never calls a transport directly.
# Stress Program

Latte validates long-horizon behavior with four suites:

- `LatteBench-SWE`: code, docs, tests, PR drafting, repo drift, and session resume
- `LatteBench-Ops`: multi-endpoint sandbox flows across GitHub, REST, email/chat, and storage
- `LatteBench-Recovery`: crashes, retries, cache corruption, duplicate deliveries, and auth expiry
- `LatteBench-Memory`: delayed follow-ups, contradiction handling, and retrieval/rerank lift

The acceptance target is a `72h` staging run with high chaos injection and a hybrid mix of local
sandbox endpoints plus real staging connectors.

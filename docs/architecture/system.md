# System Architecture

Latte keeps project repos thin and moves the harness into a managed control plane.

## Surfaces

- CLI: project-aware wrapper around Codex CLI and Claude Code
- Core: config, context compilation, session cache, memory abstractions, and stress definitions
- Workspace alpha: parent-level multi-repo manifest, status/query, snapshots, and guarded exec
- Cron manager: durable scheduled jobs, isolated/named sessions, and run ledgers
- Memory manager: local compaction sweeps into reviewable Markdown vaults
- API: managed service for indexing, briefs, sessions, and stress runs
- Worker: durable workflow execution and failure-injection test loops

## Persistence

- `.latte/`: local cache, run bundles, and resumable session metadata
- `.latte/cron/state.json`: durable cron job and run ledger
- `.latte/memory/MEMORY.md`: generated high-signal memory vault
- `latte.workspace.yaml`: optional parent manifest for related local repos
- Postgres: remote session and run metadata
- Redis: hot cache and queue/lease support
- Qdrant: indexed retrieval corpus
- Mem0: durable user/project memory

## Control Principle

Latte augments provider-native tools. It should preserve Codex and Claude capabilities instead of
forcing a lowest-common-denominator abstraction.

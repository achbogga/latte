# Latte

[![CI](https://github.com/achbogga/latte/actions/workflows/ci.yml/badge.svg)](https://github.com/achbogga/latte/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-339933)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10-f69220)](https://pnpm.io/)

Latte is a managed agentic harness that wraps Codex CLI and Claude Code without replacing their
native workflows. It handles project context compilation, long-term memory, retrieval/reranking,
session resume, and durable multi-day automation.

## What Exists Today

- npm-monorepo foundation for CLI, provider adapters, API, and worker
- deterministic context compiler and local session cache
- managed-service API skeleton with file-backed development storage
- Temporal-shaped worker scaffolding for long-running stress and recovery suites
- first-party stress scenarios for multi-endpoint, multi-day validation
- thin consumer integration configs for `boba` and `tsqbev-poc`
- GitKB-inspired multi-repo workspace alpha with guarded batch execution
- OpenClaw-inspired cron, session, memory-sweep, and extreme stress primitives

## Install

```bash
pnpm install
pnpm build
```

## Local Development

```bash
docker compose up -d postgres redis qdrant temporal temporal-ui
pnpm lint
pnpm typecheck
pnpm test
```

## Core Commands

```bash
pnpm --filter @achbogga/latte-cli exec latte doctor
pnpm --filter @achbogga/latte-cli exec latte init --project /path/to/repo
pnpm --filter @achbogga/latte-cli exec latte index --project /path/to/repo
pnpm --filter @achbogga/latte-cli exec latte brief --project /path/to/repo
pnpm --filter @achbogga/latte-cli exec latte run --project /path/to/repo --provider codex --dry-run -- "fix flaky tests"
pnpm --filter @achbogga/latte-cli exec latte agent start --project /path/to/repo
pnpm --filter @achbogga/latte-cli exec latte agent console --project /path/to/repo
pnpm --filter @achbogga/latte-cli exec latte agent submit --project /path/to/repo -- "continue the current task with this new constraint"
pnpm --filter @achbogga/latte-cli exec latte stress plan
pnpm --filter @achbogga/latte-cli exec latte stress extreme --project /path/to/repo
pnpm --filter @achbogga/latte-cli exec latte cron add --project /path/to/repo --every 30m --session isolated --name "Memory sweep" -- "Run memory sweep and summarize drift."
pnpm --filter @achbogga/latte-cli exec latte cron list --project /path/to/repo
pnpm --filter @achbogga/latte-cli exec latte sessions list --project /path/to/repo
pnpm --filter @achbogga/latte-cli exec latte memory sweep --project /path/to/repo
pnpm --filter @achbogga/latte-cli exec latte workspace init --root /home/me/projects --discover --include boba,latte
pnpm --filter @achbogga/latte-cli exec latte workspace status --root /home/me/projects
pnpm --filter @achbogga/latte-cli exec latte workspace query --root /home/me/projects "tag:harness AND dirty:false"
pnpm --filter @achbogga/latte-cli exec latte workspace exec --root /home/me/projects --include boba,latte -- git status --short
pnpm --filter @achbogga/latte-cli exec latte workspace snapshot create --root /home/me/projects before-batch-write
pnpm --filter @achbogga/latte-cli exec latte workspace skill install --root /home/me/projects
pnpm --filter @achbogga/latte-cli exec latte workspace eval gitkb-alpha --root /home/me/projects
```

## Background Loop

Latte now supports a file-backed local daemon that keeps running in the
background while you supervise it from a separate terminal.

- `latte agent start` launches the daemon if one is not already healthy.
- `latte agent console` opens an interactive supervision terminal without
  stopping the loop.
- `latte agent submit` queues new work for the background loop.
- `latte agent pause`, `resume`, and `stop` control the daemon safely.
- Runtime state lives under `.latte/agent/` and long-lived run artifacts live
  under `.latte/runs/`.

The daemon is resource-aware on the local machine. It samples system load,
memory headroom, and peer Latte daemons before starting new work, and it
requeues failed tasks with backoff so sessions recover from transient failures
instead of silently dying.

## Workspace Alpha

Latte can manage a lightweight `latte.workspace.yaml` at a parent directory so
agents get a compact multi-repo brief before cross-repo work. This is inspired
by GitKB Meta's manifest, query, snapshot, and AI-integration model, but it is
implemented natively in Latte so product repos do not need GitKB binaries.

- Workspace status and query commands expose repo health, tags, language, dirty
  state, branch, and ahead/behind signals.
- Workspace exec runs read-only commands across selected repos and forces
  mutating commands into dry-run mode unless `--allow-write` and an explicit
  snapshot are provided.
- Workspace snapshots record Git heads and dirty flags before dangerous batch
  operations.
- Background agent prompts automatically include a workspace brief when the
  project lives under a Latte workspace.

See [docs/architecture/workspace-alpha.md](docs/architecture/workspace-alpha.md)
for the safety model, manifest shape, and validation criteria.

## Cron, Sessions, And Memory

Latte now includes an OpenClaw-inspired local control plane:

- `latte cron` persists scheduled jobs and run ledgers under `.latte/cron/`.
- Cron jobs can target `main`, `isolated`, or `session:<key>` session contexts.
- `latte sessions` inspects durable sessions and compacts recent events into memory.
- `latte memory sweep` deduplicates, TTL-prunes, and promotes memory into
  `.latte/memory/MEMORY.md`.
- `latte stress extreme` runs the deterministic gauntlet for cron pressure,
  session continuity, run reconciliation, and memory sweeps.

See
[docs/architecture/openclaw-inspired-harness.md](docs/architecture/openclaw-inspired-harness.md).

## Repo Layout

- `packages/core`: shared types, config parsing, context compiler, memory/cache/session helpers
- `packages/provider-codex`: Codex launch plans and resume helpers
- `packages/provider-claude`: Claude launch plans and resume helpers
- `packages/cli`: the `latte` npm CLI
- `services/api`: managed control plane API
- `services/worker`: durable workflow and stress-run worker
- `docs/stress`: long-horizon stress program and acceptance criteria

## Why This Repo Exists

Teams should not have to re-engineer context, memory, and recovery loops in every product repo.
Latte keeps those concerns in one place and lets repos like Boba stay focused on product logic.

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
pnpm --filter @achbogga/latte-cli exec latte stress plan
```

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

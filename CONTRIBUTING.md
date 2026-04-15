# Contributing

Latte is a general-purpose agent harness. The repo is optimized for small, reviewable changes and
reproducible validation.

## Quickstart

1. Install Node `22+` and `pnpm`.
2. Run `pnpm install`.
3. Run `pnpm install` and let `simple-git-hooks` register the local hooks.
4. Run `pnpm lint && pnpm typecheck && pnpm test`.

## Commit Style

Use Conventional Commits: `type(scope): summary`.

Examples:

- `feat(cli): add session resume command`
- `fix(core): invalidate stale cache keys on repo sha change`
- `docs(stress): clarify recovery acceptance criteria`

Each commit should be one coherent unit and include tests or docs updates for the changed
behavior.

## Development Rules

- Prefer TDD for new behavior and all regressions.
- Keep provider wrappers thin. Latte augments Codex and Claude; it should not trap users in a
  custom abstraction.
- Durable execution changes require explicit replay and recovery tests.
- Retrieval and memory changes must compare against a baseline and include provenance handling.

## Checks

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `trunk check --all --no-progress`

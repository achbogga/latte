# OpenClaw-Inspired Harness Architecture

Latte adopts proven control-plane patterns from OpenClaw without copying its
runtime or code. The goal is a repo-focused harness for Codex and Claude Code:
durable background work, recoverable sessions, explicit memory maintenance, and
resource-aware scheduling.

## Evidence

OpenClaw's public docs describe several patterns that map directly to Latte:

- Cron jobs run in the gateway process, persist on disk, create background task
  records, and support main, isolated, and named/custom sessions.
- Background tasks keep a durable run ledger and a sweeper reconciles active
  work, marks lost tasks, and prunes stale terminal records.
- Sessions have durable metadata and can be queried by status/history.
- Memory uses local files, automatic flush before compaction, and optional
  scheduled consolidation into high-signal long-term memory.
- Heartbeat-style proactive runs are useful but must be explicit because short
  intervals spend tokens.

Primary sources:

- <https://docs.openclaw.ai/automation/cron-jobs>
- <https://docs.openclaw.ai/automation/tasks>
- <https://docs.openclaw.ai/concepts/session-tool>
- <https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory.md>
- <https://open-claw.bot/docs/start/openclaw/>

## Latte Mapping

Latte now has native equivalents:

- `FileCronStore` persists jobs and run records under `.latte/cron/state.json`.
- Cron jobs support `main`, `isolated`, and `session:<key>` targets.
- Every cron run creates an `AgentTask` with origin metadata and a run ledger
  entry.
- The daemon reconciles cron run status from task state and marks stale orphaned
  running tasks as `lost`.
- `FileSessionStore` supports stable session keys for named and isolated runs.
- `sweepMemory` deduplicates, TTL-prunes, scores, and promotes memory into
  `.latte/memory/MEMORY.md` with review metadata under `.latte/memory/.dreams/`.
- `latte stress extreme` runs a deterministic gauntlet covering cron pressure,
  isolated sessions, run reconciliation, and memory sweep behavior.

## Guardrails

The architecture is intentionally conservative:

- Cron concurrency defaults to one active run to avoid local resource contention.
- Isolated cron sessions get unique `cron:<jobId>:<runId>` keys.
- Named sessions are explicit via `session:<key>`.
- Memory sweep is local and reviewable; it does not silently delete all source
  state, only expired items and exact duplicates.
- The Boba-facing daemon remains resource-aware before starting any queued work.

## CLI Surface

```bash
latte cron add --project /repo --every 30m --session isolated --name "Memory sweep" -- "Run a memory sweep and report drift."
latte cron list --project /repo
latte cron run --project /repo <job-id>
latte cron runs --project /repo --id <job-id>
latte sessions list --project /repo
latte sessions show --project /repo <id-or-key>
latte sessions compact --project /repo <id-or-key>
latte memory sweep --project /repo
latte stress extreme --project /repo
```

## Stress Bar

The minimum acceptable stress bar is not "unit tests pass." It is:

- no duplicate cron run when multiple due jobs collide with concurrency limits
- no session amnesia for named cron/session keys
- no stuck active run after provider crash or orphaned task state
- memory sweep produces a human-reviewable vault
- daemon continues running after the gauntlet

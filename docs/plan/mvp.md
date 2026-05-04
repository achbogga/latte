# MVP Plan

The first Latte milestone must prove four things:

1. fresh sessions can compile useful project context without manual prompting
2. the harness can wrap Codex CLI and Claude Code without blocking native workflows
3. session state and cache survive crashes and resume cleanly
4. long-horizon stress scenarios are replayable and measurable
5. multi-repo work can start from a workspace brief instead of repeated manual context engineering

## Alpha Workspace Gate

Before treating workspace support as stable, validate the same task with and
without workspace prompt injection across Boba, Latte, and TSQBEV.

- Measure whether the agent selects the correct target repo without user hints.
- Confirm guarded exec prevents accidental multi-repo writes.
- Require snapshots before any mutating batch operation.
- Keep the GitKB-inspired surface native to Latte until the value is proven.

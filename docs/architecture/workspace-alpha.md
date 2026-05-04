# Workspace Alpha

Latte workspace alpha gives agents a read-first view over related Git
repositories without turning product repos into a monorepo or requiring a GitKB
runtime dependency.

## Inspiration

GitKB Meta demonstrates useful primitives for multi-repo agent work:

- a parent manifest that maps named projects to Git remotes
- repo query and filtering commands
- cross-repo loop execution
- snapshots before multi-repo changes
- AI-facing briefs and skills

Latte adopts the primitives that are immediately useful for local Codex and
Claude workflows, then keeps the write path deliberately conservative.

References:

- <https://github.com/gitkb/meta>
- <https://github.com/gitkb/meta/blob/main/docs/advanced_usage.md>
- <https://github.com/gitkb/meta/blob/main/docs/claude_code_skills.md>
- <https://github.com/gitkb/agent>

## Manifest

The workspace root contains `latte.workspace.yaml`.

```yaml
schemaVersion: 0.1-alpha
projects:
  boba:
    path: boba
    tags: [product, ray, python]
    depends_on: [latte]
  latte:
    path: latte
    tags: [harness, agent, typescript]
```

Latte accepts a Meta-compatible subset where a project can be either a remote
URL string or an object with `path`, `repo`, `tags`, `provides`, `depends_on`,
and `meta`.

## Commands

- `latte workspace init --discover` creates the manifest from local Git repos.
- `latte workspace status` shows branch, dirty, ahead/behind, tags, language,
  and paths.
- `latte workspace query "tag:harness AND dirty:false"` narrows target repos
  before agent work.
- `latte workspace exec -- git status --short` runs read-only commands across
  selected repos.
- `latte workspace snapshot create <name>` records Git heads and dirty flags.
- `latte workspace skill install` writes the local alpha skill under
  `.latte/skills/`.
- `latte workspace eval gitkb-alpha` writes an evidence report under
  `.latte/workspace/evals/`.

## Safety Model

Workspace commands are read-first by default.

Mutating batch commands are detected conservatively. Commands such as
`git commit`, `git reset`, `git checkout`, package-manager installs, `rm`, `mv`,
and `cp` are forced into dry-run mode unless the operator passes both
`--allow-write` and `--snapshot <name>`.

The CLI also requires that the named snapshot already exists before executing a
mutating plan. This keeps write permission explicit and prevents the harness
from silently creating a meaningless checkpoint at the same time it performs a
dangerous operation.

## Agent Integration

When a background task runs inside a repo that belongs to a workspace, Latte
injects:

- the normal task prompt
- recent session events
- retrieved durable memory
- a compact workspace brief
- the optional `gitkb-workspace-alpha` skill text

This gives Codex or Claude enough context to choose the right repos without
asking the user to re-explain the local project graph.

## Validation Criteria

The feature is useful only if it improves multi-repo work without increasing
blast radius. The alpha test suite therefore creates real temporary Git repos
and verifies:

- discovery of local Git repos and inferred tags
- filtering and query behavior
- dirty-state and Git-head inspection
- read-only batch execution
- mutating command guardrails
- snapshot creation and lookup
- skill and eval artifact generation

Next validation should compare agent tasks with and without workspace brief
injection across Boba, Latte, and TSQBEV work.

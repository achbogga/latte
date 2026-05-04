import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import { ensureDir, readJson, writeJson, writeText } from "./fs.js";
import type {
  WorkspaceEvalReport,
  WorkspaceExecPlan,
  WorkspaceExecResult,
  WorkspaceFilter,
  WorkspaceManifest,
  WorkspaceProject,
  WorkspaceProjectState,
  WorkspaceSnapshot,
  WorkspaceSnapshotProject,
  WorkspaceState,
} from "./types.js";

const workspaceFileName = "latte.workspace.yaml";

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function safeGit(projectPath: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", projectPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function safeRemoteUrl(projectPath: string): string | undefined {
  return (
    safeGit(projectPath, ["config", "--get", "remote.origin.url"]) ?? undefined
  );
}

function splitCsv(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function detectLanguage(projectPath: string): string | null {
  const files = [
    ["pyproject.toml", "python"],
    ["uv.lock", "python"],
    ["package.json", "typescript"],
    ["pnpm-lock.yaml", "typescript"],
    ["Cargo.toml", "rust"],
    ["go.mod", "go"],
  ] as const;
  for (const [fileName, language] of files) {
    try {
      execFileSync("test", ["-f", path.join(projectPath, fileName)]);
      return language;
    } catch {
      continue;
    }
  }
  return null;
}

function gitAheadBehind(projectPath: string): {
  ahead: boolean;
  behind: boolean;
} {
  const upstream = safeGit(projectPath, [
    "rev-parse",
    "--abbrev-ref",
    "@{upstream}",
  ]);
  if (!upstream) {
    return { ahead: false, behind: false };
  }
  const counts = safeGit(projectPath, [
    "rev-list",
    "--left-right",
    "--count",
    `HEAD...${upstream}`,
  ]);
  const [aheadRaw = "0", behindRaw = "0"] = counts?.split(/\s+/) ?? [];
  return {
    ahead: Number.parseInt(aheadRaw, 10) > 0,
    behind: Number.parseInt(behindRaw, 10) > 0,
  };
}

async function latestMtime(projectPath: string): Promise<string | null> {
  try {
    const entries = await readdir(projectPath, { withFileTypes: true });
    let latest = 0;
    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === ".latte" ||
        entry.name === "node_modules"
      ) {
        continue;
      }
      const entryStat = await stat(path.join(projectPath, entry.name));
      latest = Math.max(latest, entryStat.mtimeMs);
    }
    return latest > 0 ? new Date(latest).toISOString() : null;
  } catch {
    return null;
  }
}

function snapshotRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".latte", "workspace", "snapshots");
}

function evalRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".latte", "workspace", "evals");
}

export function workspaceManifestPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, workspaceFileName);
}

export async function discoverWorkspaceRoot(
  startPath: string,
  explicitRoot?: string,
): Promise<string | null> {
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  if (process.env.LATTE_WORKSPACE_ROOT) {
    return path.resolve(process.env.LATTE_WORKSPACE_ROOT);
  }

  let current = path.resolve(startPath);
  try {
    const currentStat = await stat(current);
    if (currentStat.isFile()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  while (true) {
    try {
      await stat(workspaceManifestPath(current));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

export function normalizeWorkspaceProject(
  name: string,
  value: string | Partial<WorkspaceProject>,
): WorkspaceProject {
  if (typeof value === "string") {
    return {
      dependsOn: [],
      meta: false,
      name,
      path: name,
      provides: [],
      repo: value,
      tags: [],
    };
  }
  return {
    dependsOn: normalizeList(
      (value as { depends_on?: unknown }).depends_on ?? value.dependsOn,
    ),
    meta: value.meta ?? false,
    name,
    path: value.path ?? name,
    provides: normalizeList(value.provides),
    repo: value.repo,
    tags: normalizeList(value.tags),
  };
}

export async function loadWorkspaceManifest(
  workspaceRoot: string,
): Promise<WorkspaceManifest> {
  const raw = await readFile(workspaceManifestPath(workspaceRoot), "utf8");
  const parsed = YAML.parse(raw) as WorkspaceManifest;
  return {
    ...parsed,
    projects: parsed.projects ?? {},
  };
}

export async function writeWorkspaceManifest(
  workspaceRoot: string,
  manifest: WorkspaceManifest,
): Promise<void> {
  await writeText(
    workspaceManifestPath(workspaceRoot),
    YAML.stringify(manifest),
  );
}

export async function discoverGitProjects(
  workspaceRoot: string,
  include?: string[],
): Promise<Record<string, WorkspaceProject>> {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const projects: Record<string, WorkspaceProject> = {};
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    if (include && !include.includes(entry.name)) {
      continue;
    }
    const projectPath = path.join(workspaceRoot, entry.name);
    try {
      await stat(path.join(projectPath, ".git"));
    } catch {
      continue;
    }
    projects[entry.name] = {
      dependsOn: [],
      meta: false,
      name: entry.name,
      path: entry.name,
      provides: [],
      repo: safeRemoteUrl(projectPath),
      tags: inferProjectTags(entry.name, projectPath),
    };
  }
  return projects;
}

export function inferProjectTags(name: string, projectPath: string): string[] {
  const tags = new Set<string>();
  const language = detectLanguage(projectPath);
  if (language) {
    tags.add(language);
  }
  if (name === "boba") {
    tags.add("product");
    tags.add("ray");
  }
  if (name === "latte") {
    tags.add("harness");
    tags.add("agent");
  }
  if (name === "tsqbev-poc") {
    tags.add("research");
  }
  return [...tags].sort();
}

export function workspaceProjects(
  manifest: WorkspaceManifest,
): WorkspaceProject[] {
  return Object.entries(manifest.projects).map(([name, value]) =>
    normalizeWorkspaceProject(name, value),
  );
}

export function applyWorkspaceFilter<
  T extends { name: string; tags: string[] },
>(projects: T[], filter: WorkspaceFilter = {}): T[] {
  const include = new Set(filter.include ?? []);
  const exclude = new Set(filter.exclude ?? []);
  const tags = new Set(filter.tag ?? []);
  return projects.filter((project) => {
    if (include.size > 0 && !include.has(project.name)) {
      return false;
    }
    if (exclude.has(project.name)) {
      return false;
    }
    if (tags.size > 0 && !project.tags.some((tag) => tags.has(tag))) {
      return false;
    }
    return true;
  });
}

export async function inspectWorkspaceState(
  workspaceRoot: string,
  filter: WorkspaceFilter = {},
): Promise<WorkspaceState> {
  const manifest = await loadWorkspaceManifest(workspaceRoot);
  const projects = applyWorkspaceFilter(workspaceProjects(manifest), filter);
  const states: WorkspaceProjectState[] = [];
  for (const project of projects) {
    const projectPath = path.resolve(workspaceRoot, project.path);
    const exists = await stat(projectPath)
      .then((entry) => entry.isDirectory())
      .catch(() => false);
    const aheadBehind = exists
      ? gitAheadBehind(projectPath)
      : { ahead: false, behind: false };
    states.push({
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      branch: exists
        ? safeGit(projectPath, ["branch", "--show-current"])
        : null,
      dirty: exists
        ? (safeGit(projectPath, ["status", "--porcelain"]) ?? "").length > 0
        : false,
      exists,
      head: exists ? safeGit(projectPath, ["rev-parse", "HEAD"]) : null,
      language: exists ? detectLanguage(projectPath) : null,
      lastModifiedAt: exists ? await latestMtime(projectPath) : null,
      name: project.name,
      path: projectPath,
      repo: project.repo,
      tags: project.tags,
    });
  }
  return {
    generatedAt: nowIso(),
    projects: states,
    root: workspaceRoot,
  };
}

export function queryWorkspaceState(
  state: WorkspaceState,
  expression: string,
): WorkspaceProjectState[] {
  const clauses = expression
    .split(/\s+AND\s+/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
  return state.projects.filter((project) =>
    clauses.every((clause) => matchWorkspaceClause(project, clause)),
  );
}

function matchWorkspaceClause(
  project: WorkspaceProjectState,
  clause: string,
): boolean {
  const [key, ...rest] = clause.split(":");
  const value = rest.join(":");
  if (!key || !value) {
    return false;
  }
  if (key === "dirty") {
    return project.dirty === (value === "true");
  }
  if (key === "ahead") {
    return project.ahead === (value === "true");
  }
  if (key === "behind") {
    return project.behind === (value === "true");
  }
  if (key === "branch") {
    return project.branch === value;
  }
  if (key === "tag") {
    return project.tags.includes(value);
  }
  if (key === "language") {
    return project.language === value;
  }
  return false;
}

export function isMutatingWorkspaceCommand(command: string[]): boolean {
  const joined = command.join(" ");
  return [
    /\bgit\s+(add|am|apply|checkout|clean|commit|merge|mv|pull|push|rebase|reset|restore|rm|stash|switch)\b/,
    /\brm\s+-/,
    /\bmv\s+/,
    /\bcp\s+/,
    /\bpnpm\s+(install|add|remove|update)\b/,
    /\bnpm\s+(install|update|uninstall)\b/,
    /\buv\s+(add|remove|sync)\b/,
  ].some((pattern) => pattern.test(joined));
}

export async function buildWorkspaceExecPlan(
  workspaceRoot: string,
  command: string[],
  filter: WorkspaceFilter = {},
  options: { allowWrite?: boolean; dryRun?: boolean; snapshot?: string } = {},
): Promise<WorkspaceExecPlan> {
  const state = await inspectWorkspaceState(workspaceRoot, filter);
  const mutating = isMutatingWorkspaceCommand(command);
  const requiresSnapshot = mutating && !options.snapshot;
  if (mutating && (!options.allowWrite || requiresSnapshot)) {
    return {
      command,
      dryRun: true,
      mutating,
      projects: state.projects
        .filter((project) => project.exists)
        .map((project) => ({ command, cwd: project.path, name: project.name })),
      requiresSnapshot,
      snapshot: options.snapshot,
    };
  }
  return {
    command,
    dryRun: options.dryRun ?? false,
    mutating,
    projects: state.projects
      .filter((project) => project.exists)
      .map((project) => ({ command, cwd: project.path, name: project.name })),
    requiresSnapshot: false,
    snapshot: options.snapshot,
  };
}

export function runWorkspaceExecPlan(
  plan: WorkspaceExecPlan,
): WorkspaceExecResult[] {
  if (plan.dryRun) {
    return [];
  }
  return plan.projects.map((project) => {
    const [binary, ...args] = project.command;
    if (!binary) {
      return {
        command: project.command,
        cwd: project.cwd,
        exitCode: 127,
        name: project.name,
        stderr: "empty command",
        stdout: "",
      };
    }
    const result = spawnSync(binary, args, {
      cwd: project.cwd,
      encoding: "utf8",
      shell: false,
    });
    return {
      command: project.command,
      cwd: project.cwd,
      exitCode: result.status,
      name: project.name,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? "",
    };
  });
}

export async function createWorkspaceSnapshot(
  workspaceRoot: string,
  name: string,
  filter: WorkspaceFilter = {},
): Promise<WorkspaceSnapshot> {
  const state = await inspectWorkspaceState(workspaceRoot, filter);
  const snapshot: WorkspaceSnapshot = {
    createdAt: nowIso(),
    name,
    projects: state.projects.map(
      (project): WorkspaceSnapshotProject => ({
        branch: project.branch,
        dirty: project.dirty,
        head: project.head,
        name: project.name,
        path: project.path,
      }),
    ),
    root: workspaceRoot,
  };
  await writeJson(
    path.join(snapshotRoot(workspaceRoot), `${name}.json`),
    snapshot,
  );
  return snapshot;
}

export async function listWorkspaceSnapshots(
  workspaceRoot: string,
): Promise<WorkspaceSnapshot[]> {
  await ensureDir(snapshotRoot(workspaceRoot));
  const entries = await readdir(snapshotRoot(workspaceRoot));
  const snapshots = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) =>
        readJson<WorkspaceSnapshot | null>(
          path.join(snapshotRoot(workspaceRoot), entry),
          null,
        ),
      ),
  );
  return snapshots
    .filter((snapshot): snapshot is WorkspaceSnapshot => snapshot !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readWorkspaceSnapshot(
  workspaceRoot: string,
  name: string,
): Promise<WorkspaceSnapshot | null> {
  return readJson<WorkspaceSnapshot | null>(
    path.join(snapshotRoot(workspaceRoot), `${name}.json`),
    null,
  );
}

export function buildWorkspaceRestorePlan(
  snapshot: WorkspaceSnapshot,
): WorkspaceExecPlan {
  return {
    command: ["git", "checkout", "<snapshot-head>"],
    dryRun: true,
    mutating: true,
    projects: snapshot.projects
      .filter((project) => project.head)
      .map((project) => ({
        command: ["git", "checkout", project.head ?? ""],
        cwd: project.path,
        name: project.name,
      })),
    requiresSnapshot: false,
    snapshot: snapshot.name,
  };
}

export function renderWorkspaceBrief(
  state: WorkspaceState,
  currentPath?: string,
): string {
  const current = currentPath
    ? state.projects.find((project) => currentPath.startsWith(project.path))
    : undefined;
  const rows = state.projects.map((project) => {
    const flags = [
      project.dirty ? "dirty" : "clean",
      project.ahead ? "ahead" : null,
      project.behind ? "behind" : null,
      project.branch ? `branch=${project.branch}` : null,
      project.tags.length > 0 ? `tags=${project.tags.join(",")}` : null,
    ].filter(Boolean);
    return `- ${project.name}: ${flags.join(" ") || "no git state"} (${project.path})`;
  });
  return [
    "# Latte Workspace Brief",
    `root: ${state.root}`,
    `current repo: ${current?.name ?? "unknown"}`,
    `projects: ${state.projects.length}`,
    "",
    ...rows,
  ].join("\n");
}

export async function installWorkspaceSkill(
  workspaceRoot: string,
): Promise<string> {
  const skillPath = path.join(
    workspaceRoot,
    ".latte",
    "skills",
    "gitkb-workspace-alpha.md",
  );
  await writeText(
    skillPath,
    [
      "# gitkb-workspace-alpha",
      "",
      "Use Latte workspace commands when a task spans multiple repositories.",
      "",
      "- Start with `latte workspace status --json` before cross-repo work.",
      "- Use `latte workspace query` to narrow the target repos.",
      "- Use `latte workspace brief` before asking an agent to reason across repos.",
      "- Run `latte workspace exec --dry-run -- <cmd>` before batch commands.",
      "- Mutating batch commands require an explicit snapshot and `--allow-write`.",
      "",
    ].join("\n"),
  );
  return skillPath;
}

export async function buildWorkspaceEvalReport(
  workspaceRoot: string,
): Promise<WorkspaceEvalReport> {
  const state = await inspectWorkspaceState(workspaceRoot);
  const discovered = await discoverGitProjects(workspaceRoot);
  const brief = renderWorkspaceBrief(state);
  const singleRepoOverhead = Math.max(
    ...state.projects.map(
      (project) => project.name.length + project.path.length,
    ),
    1,
  );
  const contextOverheadRatio = brief.length / Math.max(singleRepoOverhead, 1);
  const dirtyRepoCount = state.projects.filter(
    (project) => project.dirty,
  ).length;
  const useful =
    state.projects.length >= 3 &&
    Object.keys(discovered).length >= state.projects.length &&
    dirtyRepoCount >= 0;
  const report: WorkspaceEvalReport = {
    generatedAt: nowIso(),
    metrics: {
      contextOverheadRatio,
      dirtyRepoCount,
      discoveredRepoCount: Object.keys(discovered).length,
      workspaceProjectCount: state.projects.length,
    },
    recommendations: [
      "Use workspace status before multi-repo agent tasks.",
      "Keep alpha writes behind snapshots until evals show consistent benefit.",
      "Compare daemon tasks with and without workspace brief injection.",
    ],
    root: workspaceRoot,
    scenario: "gitkb-alpha",
    useful,
  };
  await ensureDir(evalRoot(workspaceRoot));
  await writeJson(
    path.join(evalRoot(workspaceRoot), `gitkb-alpha-${randomUUID()}.json`),
    report,
  );
  return report;
}

export const workspaceCli = {
  splitCsv,
};

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildWorkspaceEvalReport,
  buildWorkspaceExecPlan,
  createWorkspaceSnapshot,
  discoverGitProjects,
  inspectWorkspaceState,
  installWorkspaceSkill,
  queryWorkspaceState,
  readWorkspaceSnapshot,
  renderWorkspaceBrief,
  runWorkspaceExecPlan,
  writeWorkspaceManifest,
  type WorkspaceManifest,
} from "../packages/core/src/index.js";

async function createRepo(
  workspaceRoot: string,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const repoPath = path.join(workspaceRoot, name);
  await mkdir(repoPath, { recursive: true });
  for (const [fileName, body] of Object.entries(files)) {
    const filePath = path.join(repoPath, fileName);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body, "utf8");
  }
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tests@example.com"], {
    cwd: repoPath,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Latte Tests"], {
    cwd: repoPath,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "chore: initial commit"], {
    cwd: repoPath,
    stdio: "ignore",
  });
  return repoPath;
}

async function createWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "latte-workspace-"));
}

describe("workspace alpha", () => {
  test("discovers, filters, and queries real git repositories", async () => {
    const workspaceRoot = await createWorkspace();
    await createRepo(workspaceRoot, "boba", {
      "README.md": "# Boba\n",
      "pyproject.toml": '[project]\nname = "boba"\n',
    });
    await createRepo(workspaceRoot, "latte", {
      "README.md": "# Latte\n",
      "package.json": '{"name":"latte"}\n',
    });

    const discovered = await discoverGitProjects(workspaceRoot, [
      "boba",
      "latte",
    ]);
    await writeWorkspaceManifest(workspaceRoot, {
      generatedAt: "2026-05-04T00:00:00.000Z",
      projects: discovered,
      schemaVersion: "0.1-alpha",
    });

    expect(discovered.boba?.tags).toContain("ray");
    expect(discovered.latte?.tags).toContain("harness");

    const harnessState = await inspectWorkspaceState(workspaceRoot, {
      tag: ["harness"],
    });
    expect(harnessState.projects.map((project) => project.name)).toEqual([
      "latte",
    ]);

    const allState = await inspectWorkspaceState(workspaceRoot);
    const queried = queryWorkspaceState(
      allState,
      "tag:harness AND dirty:false",
    );
    expect(queried.map((project) => project.name)).toEqual(["latte"]);
    expect(
      renderWorkspaceBrief(allState, path.join(workspaceRoot, "boba")),
    ).toContain("current repo: boba");
  });

  test("guards mutating batch commands behind snapshots", async () => {
    const workspaceRoot = await createWorkspace();
    await createRepo(workspaceRoot, "latte", {
      "README.md": "# Latte\n",
      "package.json": '{"name":"latte"}\n',
    });
    await writeWorkspaceManifest(workspaceRoot, {
      projects: await discoverGitProjects(workspaceRoot),
      schemaVersion: "0.1-alpha",
    });

    const readOnlyPlan = await buildWorkspaceExecPlan(workspaceRoot, [
      "git",
      "status",
      "--short",
    ]);
    expect(readOnlyPlan.dryRun).toBe(false);
    expect(readOnlyPlan.mutating).toBe(false);

    const blocked = await buildWorkspaceExecPlan(workspaceRoot, [
      "git",
      "commit",
      "--allow-empty",
      "-m",
      "test",
    ]);
    expect(blocked.dryRun).toBe(true);
    expect(blocked.requiresSnapshot).toBe(true);

    const snapshot = await createWorkspaceSnapshot(
      workspaceRoot,
      "before-write",
    );
    expect(snapshot.projects[0]?.head).toMatch(/[0-9a-f]{40}/);
    expect(
      await readWorkspaceSnapshot(workspaceRoot, "before-write"),
    ).not.toBeNull();

    const allowed = await buildWorkspaceExecPlan(
      workspaceRoot,
      ["git", "commit", "--allow-empty", "-m", "test"],
      {},
      { allowWrite: true, snapshot: "before-write" },
    );
    expect(allowed.dryRun).toBe(false);
    expect(allowed.requiresSnapshot).toBe(false);
  });

  test("runs read-only exec and writes alpha skill and eval artifacts", async () => {
    const workspaceRoot = await createWorkspace();
    await createRepo(workspaceRoot, "boba", {
      "README.md": "# Boba\n",
      "pyproject.toml": '[project]\nname = "boba"\n',
    });
    await createRepo(workspaceRoot, "latte", {
      "README.md": "# Latte\n",
      "package.json": '{"name":"latte"}\n',
    });
    await createRepo(workspaceRoot, "tsqbev-poc", {
      "README.md": "# TSQBEV\n",
      "pyproject.toml": '[project]\nname = "tsqbev-poc"\n',
    });
    const manifest: WorkspaceManifest = {
      projects: await discoverGitProjects(workspaceRoot),
      schemaVersion: "0.1-alpha",
    };
    await writeWorkspaceManifest(workspaceRoot, manifest);

    const plan = await buildWorkspaceExecPlan(workspaceRoot, [
      "git",
      "status",
      "--short",
    ]);
    const results = runWorkspaceExecPlan(plan);
    expect(results).toHaveLength(3);
    expect(results.every((result) => result.exitCode === 0)).toBe(true);

    const skillPath = await installWorkspaceSkill(workspaceRoot);
    expect(await readFile(skillPath, "utf8")).toContain(
      "gitkb-workspace-alpha",
    );

    const report = await buildWorkspaceEvalReport(workspaceRoot);
    expect(report.scenario).toBe("gitkb-alpha");
    expect(report.useful).toBe(true);
    expect(report.metrics.workspaceProjectCount).toBe(3);
  });
});

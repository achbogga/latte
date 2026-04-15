import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { compileContextPack } from "../packages/core/src/context.js";

describe("compileContextPack", () => {
  test("collects repo files and summaries", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "latte-context-"));
    await writeFile(path.join(projectRoot, "README.md"), "# Demo\n");
    await writeFile(path.join(projectRoot, "AGENTS.md"), "repo rules\n");
    await writeFile(
      path.join(projectRoot, "package.json"),
      '{"name":"demo"}\n',
    );

    const pack = await compileContextPack(projectRoot);

    expect(pack.projectKey).toContain("latte-context-");
    expect(pack.artifacts.map((artifact) => artifact.path)).toContain(
      "README.md",
    );
    expect(pack.rules).toContain("AGENTS.md");
    expect(pack.summary[0]).toContain("repo:");
  });
});

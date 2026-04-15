import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";
import ignore from "ignore";

import { loadLatteConfig } from "./config.js";
import type { ContextArtifact, ContextPack, LatteConfig } from "./types.js";

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeGit(projectRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", projectRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export async function compileContextPack(
  projectRoot: string,
  config?: LatteConfig,
): Promise<ContextPack> {
  const resolvedConfig = config ?? (await loadLatteConfig(projectRoot));
  const ig = ignore().add(resolvedConfig.ignore);
  const files = await fg(resolvedConfig.context.include, {
    cwd: projectRoot,
    dot: false,
    onlyFiles: true,
    unique: true,
  });

  const selected = files
    .filter((filePath) => !ig.ignores(filePath))
    .slice(0, resolvedConfig.context.maxFiles);
  const artifacts: ContextArtifact[] = [];
  for (const relativePath of selected) {
    const absolutePath = path.join(projectRoot, relativePath);
    const raw = await readFile(absolutePath, "utf8");
    const content = raw.slice(0, resolvedConfig.context.maxCharsPerFile);
    artifacts.push({
      content,
      contentHash: stableHash(content),
      path: relativePath,
      size: raw.length,
    });
  }

  const rules = artifacts
    .filter((artifact) => resolvedConfig.rulesFiles.includes(artifact.path))
    .map((artifact) => artifact.path);

  const branch = safeGit(projectRoot, ["branch", "--show-current"]);
  const sha = safeGit(projectRoot, ["rev-parse", "HEAD"]);
  const projectKey = resolvedConfig.namespace;

  return {
    artifacts,
    generatedAt: new Date().toISOString(),
    projectKey,
    repo: {
      branch,
      root: projectRoot,
      sha,
    },
    rules,
    summary: buildContextSummary(projectRoot, artifacts, branch, sha),
  };
}

export function buildContextSummary(
  projectRoot: string,
  artifacts: ContextArtifact[],
  branch: string | null,
  sha: string | null,
): string[] {
  const topFiles = artifacts
    .slice(0, 5)
    .map((artifact) => `${artifact.path} (${artifact.size} chars)`)
    .join(", ");
  return [
    `repo: ${path.basename(projectRoot)}`,
    `branch: ${branch ?? "unknown"}`,
    `sha: ${sha ?? "unknown"}`,
    `captured files: ${artifacts.length}`,
    `top context files: ${topFiles || "none"}`,
  ];
}

export function renderPromptEnvelope(
  prompt: string,
  contextPack: ContextPack,
): string {
  const sections = [
    "# Latte Context Brief",
    ...contextPack.summary.map((line) => `- ${line}`),
    "",
    "## Rules Files",
    ...(contextPack.rules.length > 0
      ? contextPack.rules.map((rule) => `- ${rule}`)
      : ["- none"]),
    "",
    "## User Prompt",
    prompt.trim(),
  ];

  return `${sections.join("\n")}\n`;
}

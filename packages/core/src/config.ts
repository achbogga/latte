import path from "node:path";
import { readFile } from "node:fs/promises";

import { z } from "zod";
import YAML from "yaml";

import type { LatteConfig, ProviderName } from "./types.js";

const defaultIncludes = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/**/*.md",
  "specs/**/*.md",
  "program.md",
  "package.json",
  "pyproject.toml",
  "src/**/*.{ts,tsx,js,py,md}",
  "services/**/*.{ts,tsx,js,py,md}",
  "packages/**/*.{ts,tsx,js,py,md}",
] as const;

const providerSchema = z.object({
  argsTemplate: z.array(z.string()).default(["{{prompt_file}}"]),
  command: z.string(),
  env: z.record(z.string(), z.string()).optional(),
});

const contextSchema = z.object({
  include: z.array(z.string()).default([...defaultIncludes]),
  maxCharsPerFile: z.number().int().positive().default(4_000),
  maxFiles: z.number().int().positive().default(24),
});

const configSchema = z.object({
  context: contextSchema.default({
    include: [...defaultIncludes],
    maxCharsPerFile: 4_000,
    maxFiles: 24,
  }),
  exports: z.array(z.string()).default(["docs/reports/**"]),
  ignore: z
    .array(z.string())
    .default([".git/**", ".latte/**", "node_modules/**", "dist/**"]),
  name: z.string(),
  namespace: z.string(),
  providers: z.object({
    claude: providerSchema.default({
      argsTemplate: ["--resume", "{{session_id}}", "{{prompt_file}}"],
      command: "claude",
    }),
    codex: providerSchema.default({
      argsTemplate: ["{{prompt_file}}"],
      command: "codex",
    }),
    default: z.enum(["claude", "codex"]).default("codex"),
  }),
  rulesFiles: z.array(z.string()).default(["AGENTS.md", "CLAUDE.md"]),
});

export function buildDefaultConfig(
  projectRoot: string,
  provider: ProviderName = "codex",
): LatteConfig {
  const repoName = path.basename(projectRoot);
  return configSchema.parse({
    name: repoName,
    namespace: repoName.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase(),
    providers: { default: provider },
  });
}

export async function loadLatteConfig(
  projectRoot: string,
): Promise<LatteConfig> {
  const configPath = path.join(projectRoot, "latte.yaml");
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = YAML.parse(raw) as Record<string, unknown>;
    return configSchema.parse(parsed);
  } catch {
    return buildDefaultConfig(projectRoot);
  }
}

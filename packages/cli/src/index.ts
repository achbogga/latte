#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";
import YAML from "yaml";

import {
  JsonMemoryStore,
  buildDefaultConfig,
  compileContextPack,
  createCacheKey,
  createStressRun,
  defaultStressScenarios,
  ensureDir,
  FileSessionStore,
  loadLatteConfig,
  readManagedAuth,
  resolveProjectStateRoot,
  saveManagedAuth,
  writeJson,
  writeText,
} from "@achbogga/latte-core";
import { buildClaudeLaunchPlan } from "@achbogga/latte-provider-claude";
import { buildCodexLaunchPlan } from "@achbogga/latte-provider-codex";

type RunOptions = {
  dryRun?: boolean;
  execute?: boolean;
  passthrough?: string[];
  project: string;
  provider?: "claude" | "codex";
  sessionId?: string;
};

const program = new Command();

program
  .name("latte")
  .description("Managed harness wrapper for Codex CLI and Claude Code")
  .version("0.1.0");

program
  .command("init")
  .requiredOption("--project <path>", "Target project root")
  .option("--provider <provider>", "Default provider", "codex")
  .action(
    async ({
      project,
      provider,
    }: {
      project: string;
      provider: "claude" | "codex";
    }) => {
      const projectRoot = path.resolve(project);
      const config = buildDefaultConfig(projectRoot, provider);
      await writeText(
        path.join(projectRoot, "latte.yaml"),
        YAML.stringify(config),
      );
      await writeText(
        path.join(projectRoot, ".latteignore"),
        [".git/", ".latte/", "node_modules/", "dist/", "coverage/"].join("\n") +
          "\n",
      );
      console.log(`Initialized Latte in ${projectRoot}`);
    },
  );

program
  .command("login")
  .option(
    "--api-key <token>",
    "Managed service token",
    process.env.LATTE_API_KEY,
  )
  .action(async ({ apiKey }: { apiKey?: string }) => {
    if (!apiKey) {
      throw new Error("Missing API key. Pass --api-key or set LATTE_API_KEY.");
    }
    await saveManagedAuth(apiKey);
    console.log("Saved managed-service credentials.");
  });

program
  .command("doctor")
  .requiredOption("--project <path>", "Target project root")
  .action(async ({ project }: { project: string }) => {
    const projectRoot = path.resolve(project);
    const config = await loadLatteConfig(projectRoot);
    const auth = await readManagedAuth();
    const checks = [
      config.providers.codex.command,
      config.providers.claude.command,
    ].map((command) => {
      try {
        const resolved = execFileSync(
          "bash",
          ["-lc", `command -v ${command}`],
          {
            encoding: "utf8",
          },
        ).trim();
        return { command, resolved, status: "found" };
      } catch {
        return { command, resolved: null, status: "missing" };
      }
    });
    console.log(
      JSON.stringify(
        {
          auth: auth ? "configured" : "missing",
          projectRoot,
          providers: checks,
        },
        null,
        2,
      ),
    );
  });

program
  .command("index")
  .requiredOption("--project <path>", "Target project root")
  .option("--push", "Push the index payload to the managed API")
  .action(async ({ project, push }: { project: string; push?: boolean }) => {
    const projectRoot = path.resolve(project);
    const config = await loadLatteConfig(projectRoot);
    const contextPack = await compileContextPack(projectRoot, config);
    const stateRoot = resolveProjectStateRoot(projectRoot);
    await writeJson(path.join(stateRoot, "index", "latest.json"), contextPack);
    if (push) {
      const auth = await readManagedAuth();
      const apiUrl = process.env.LATTE_API_URL ?? "http://127.0.0.1:8787";
      await fetch(`${apiUrl}/v1/index`, {
        body: JSON.stringify(contextPack),
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: `Bearer ${auth.apiKey}` } : {}),
        },
        method: "POST",
      });
    }
    console.log(
      `Indexed ${contextPack.artifacts.length} files for ${contextPack.projectKey}`,
    );
  });

program
  .command("brief")
  .requiredOption("--project <path>", "Target project root")
  .action(async ({ project }: { project: string }) => {
    const projectRoot = path.resolve(project);
    const contextPack = await compileContextPack(projectRoot);
    console.log(contextPack.summary.join("\n"));
  });

async function buildLaunchPlan(prompt: string, options: RunOptions) {
  const projectRoot = path.resolve(options.project);
  const config = await loadLatteConfig(projectRoot);
  const contextPack = await compileContextPack(projectRoot, config);
  const stateRoot = resolveProjectStateRoot(projectRoot);
  const store = new FileSessionStore(projectRoot);
  const cacheKey = createCacheKey({
    provider: options.provider ?? config.providers.default,
    repoSha: contextPack.repo.sha ?? "unknown",
    rules: contextPack.rules.join(","),
  });
  const session =
    options.sessionId && (await store.get(options.sessionId))
      ? await store.get(options.sessionId)
      : await store.create(
          contextPack.projectKey,
          options.provider ?? config.providers.default,
          cacheKey,
        );
  if (!session) {
    throw new Error("Failed to resolve session.");
  }
  const outputDir = path.join(stateRoot, "runs", session.id);
  await ensureDir(outputDir);
  const plan =
    (options.provider ?? config.providers.default) === "claude"
      ? await buildClaudeLaunchPlan({
          contextPack,
          outputDir,
          passthroughArgs: options.passthrough ?? [],
          prompt,
          promptFileName: "prompt.md",
          session,
        })
      : await buildCodexLaunchPlan({
          contextPack,
          outputDir,
          passthroughArgs: options.passthrough ?? [],
          prompt,
          promptFileName: "prompt.md",
          session,
        });

  session.lastPrompt = prompt;
  session.lastProviderCommand = plan.command;
  await store.save(session);
  return plan;
}

async function executeLaunchPlan(command: string[]): Promise<void> {
  const [binary, ...args] = command;
  if (!binary) {
    throw new Error("Provider launch plan did not include a command.");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: "inherit" });
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Provider command exited with ${code ?? "unknown"}`));
    });
  });
}

program
  .command("run")
  .requiredOption("--project <path>", "Target project root")
  .option("--provider <provider>", "Provider override")
  .option("--session-id <id>", "Resume a known session")
  .option("--dry-run", "Print the provider command instead of executing")
  .option("--execute", "Run the provider command immediately")
  .option("--passthrough <arg...>", "Extra provider arguments")
  .argument("<prompt...>")
  .action(async (promptParts: string[], options: RunOptions) => {
    const prompt = promptParts.join(" ");
    const plan = await buildLaunchPlan(prompt, options);
    if (!options.execute || options.dryRun) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    await executeLaunchPlan(plan.command);
  });

program
  .command("resume")
  .requiredOption("--project <path>", "Target project root")
  .requiredOption("--session-id <id>", "Session to resume")
  .option("--provider <provider>", "Provider override")
  .option("--dry-run", "Print the provider command instead of executing")
  .option("--execute", "Run the provider command immediately")
  .option("--passthrough <arg...>", "Extra provider arguments")
  .argument("[prompt...]")
  .action(async (promptParts: string[], options: RunOptions) => {
    const prompt =
      promptParts.join(" ") ||
      "Resume the previous task using the latest durable context.";
    const plan = await buildLaunchPlan(prompt, options);
    if (!options.execute || options.dryRun) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    await executeLaunchPlan(plan.command);
  });

const memory = program
  .command("memory")
  .description("Manage local durable memory");

memory
  .command("add")
  .requiredOption("--project <path>", "Target project root")
  .requiredOption("--kind <kind>", "fact|episodic|policy|procedure")
  .argument("<content...>")
  .action(
    async (
      contentParts: string[],
      { kind, project }: { kind: string; project: string },
    ) => {
      const projectRoot = path.resolve(project);
      const config = await loadLatteConfig(projectRoot);
      const store = new JsonMemoryStore(resolveProjectStateRoot(projectRoot));
      const item = await store.add({
        confidence: 0.7,
        content: contentParts.join(" "),
        kind: kind as "episodic" | "fact" | "policy" | "procedure",
        metadata: {},
        namespace: config.namespace,
        provenance: ["cli"],
      });
      console.log(JSON.stringify(item, null, 2));
    },
  );

memory
  .command("search")
  .requiredOption("--project <path>", "Target project root")
  .argument("<query...>")
  .action(async (queryParts: string[], { project }: { project: string }) => {
    const projectRoot = path.resolve(project);
    const config = await loadLatteConfig(projectRoot);
    const store = new JsonMemoryStore(resolveProjectStateRoot(projectRoot));
    const results = await store.search(config.namespace, queryParts.join(" "));
    console.log(JSON.stringify(results, null, 2));
  });

const stress = program
  .command("stress")
  .description("Stress scenarios and recovery drills");

stress
  .command("plan")
  .requiredOption("--project <path>", "Target project root")
  .action(async ({ project }: { project: string }) => {
    const config = await loadLatteConfig(path.resolve(project));
    console.log(
      JSON.stringify(defaultStressScenarios(config.namespace), null, 2),
    );
  });

stress
  .command("start")
  .requiredOption("--project <path>", "Target project root")
  .requiredOption("--scenario <id>", "Scenario identifier")
  .action(
    async ({ project, scenario }: { project: string; scenario: string }) => {
      const projectRoot = path.resolve(project);
      const config = await loadLatteConfig(projectRoot);
      const match = defaultStressScenarios(config.namespace).find(
        (candidate) => candidate.id === scenario,
      );
      if (!match) {
        throw new Error(`Unknown scenario ${scenario}`);
      }
      const run = createStressRun(match);
      await writeJson(
        path.join(
          resolveProjectStateRoot(projectRoot),
          "stress",
          `${run.id}.json`,
        ),
        run,
      );
      console.log(JSON.stringify(run, null, 2));
    },
  );

program
  .command("sync-rules")
  .requiredOption("--project <path>", "Target project root")
  .action(async ({ project }: { project: string }) => {
    const projectRoot = path.resolve(project);
    const agentsPath = path.join(projectRoot, "AGENTS.md");
    const claudePath = path.join(projectRoot, "CLAUDE.md");
    try {
      await access(agentsPath);
      const body = [
        "# CLAUDE Rules",
        "",
        "This file is generated from `AGENTS.md` and should stay aligned with the repo contract.",
        "",
        "Refer to `AGENTS.md` for the canonical rule set.",
        "",
      ].join("\n");
      await writeText(claudePath, body);
      console.log(`Synced ${claudePath}`);
    } catch {
      console.log(`No AGENTS.md found in ${projectRoot}`);
    }
  });

void program.parseAsync(process.argv);

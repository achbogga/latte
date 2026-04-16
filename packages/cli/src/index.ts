#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { Command } from "commander";
import YAML from "yaml";

import {
  applyAgentCommand,
  assessAgentResources,
  buildDefaultConfig,
  buildResourceSnapshot,
  compileContextPack,
  createAgentCommand,
  createCacheKey,
  createStressRun,
  detectTransientFailureSignature,
  defaultStressScenarios,
  ensureDir,
  FileAgentStore,
  FileSessionStore,
  JsonMemoryStore,
  loadLatteConfig,
  markTaskCompleted,
  markTaskRetry,
  markTaskRunning,
  noteResourceAssessment,
  readJson,
  readManagedAuth,
  renderPromptEnvelope,
  resolveProjectStateRoot,
  saveManagedAuth,
  selectRunnableTask,
  writeJson,
  writeText,
  type AgentDaemonState,
  type AgentTask,
  type LatteConfig,
  type ProviderName,
  type SessionRecord,
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

type AgentOptions = {
  foreground?: boolean;
  project: string;
  provider?: ProviderName;
};

type TaskExitEnvelope = {
  code: number | null;
  finishedAt: string;
  signal: NodeJS.Signals | null;
};

const program = new Command();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function summarizeState(state: AgentDaemonState | null): Record<string, unknown> {
  if (!state) {
    return {
      status: "missing",
    };
  }
  const queued = state.tasks.filter((task) => task.status === "queued").length;
  const running = state.tasks.filter((task) => task.status === "running").length;
  const completed = state.tasks.filter(
    (task) => task.status === "completed",
  ).length;
  const failed = state.tasks.filter((task) => task.status === "failed").length;
  return {
    activeRun: state.activeRun
      ? {
          pid: state.activeRun.pid,
          taskId: state.activeRun.taskId,
        }
      : null,
    completed,
    failed,
    heartbeatAt: state.heartbeatAt,
    paused: state.status === "paused",
    pid: state.pid ?? null,
    projectKey: state.projectKey,
    queued,
    running,
    status: state.status,
  };
}

async function buildForegroundLaunchPlan(prompt: string, options: RunOptions) {
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
  const existingSession = options.sessionId
    ? await store.get(options.sessionId)
    : null;
  const session =
    existingSession ??
    (await store.create(
      contextPack.projectKey,
      options.provider ?? config.providers.default,
      cacheKey,
    ));
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

async function executeForegroundLaunchPlan(command: string[]): Promise<void> {
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

async function resolveSessionForTask(
  projectRoot: string,
  config: LatteConfig,
  task: AgentTask,
  cacheKey: string,
): Promise<SessionRecord> {
  const sessions = new FileSessionStore(projectRoot);
  if (task.sessionId) {
    const existing = await sessions.get(task.sessionId);
    if (existing) {
      return existing;
    }
  }

  const all = await sessions.list();
  const latest = all
    .filter(
      (session) =>
        session.projectKey === config.namespace && session.provider === task.provider,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (latest) {
    return latest;
  }
  return sessions.create(config.namespace, task.provider, cacheKey);
}

async function buildTaskPrompt(
  projectRoot: string,
  config: LatteConfig,
  session: SessionRecord,
  task: AgentTask,
): Promise<string> {
  const stateRoot = resolveProjectStateRoot(projectRoot);
  const memory = new JsonMemoryStore(stateRoot);
  const hits = (await memory.search(config.namespace, task.prompt)).slice(0, 3);
  const recentEvents = session.events
    .slice(-5)
    .map(
      (event) =>
        `- ${event.timestamp}: ${event.type} ${JSON.stringify(event.payload)}`,
    );

  const sections = [task.prompt.trim()];
  if (recentEvents.length > 0) {
    sections.push("", "## Recent session events", ...recentEvents);
  }
  if (hits.length > 0) {
    sections.push(
      "",
      "## Retrieved durable memory",
      ...hits.map((hit, index) => `${index + 1}. ${hit.content}`),
    );
  }
  return `${sections.join("\n")}\n`;
}

async function launchBackgroundTask(
  projectRoot: string,
  config: LatteConfig,
  state: AgentDaemonState,
  task: AgentTask,
) {
  if (task.provider !== "codex") {
    throw new Error(
      `Background loop currently supports codex only. Received ${task.provider}.`,
    );
  }

  const contextPack = await compileContextPack(projectRoot, config);
  const cacheKey = createCacheKey({
    provider: task.provider,
    repoSha: contextPack.repo.sha ?? "unknown",
    rules: contextPack.rules.join(","),
  });
  const session = await resolveSessionForTask(projectRoot, config, task, cacheKey);
  const promptText = await buildTaskPrompt(projectRoot, config, session, task);
  const runPath = path.join(
    resolveProjectStateRoot(projectRoot),
    "runs",
    session.id,
    task.id,
  );
  await ensureDir(runPath);
  const promptPath = path.join(runPath, "prompt.md");
  const logPath = path.join(runPath, "events.jsonl");
  const outputPath = path.join(runPath, "last-message.txt");
  const exitPath = path.join(runPath, "exit.json");
  const envelope = renderPromptEnvelope(promptText, contextPack);
  await writeText(promptPath, envelope);

  const binary = "codex";
  const args = [
    "exec",
    "--full-auto",
    "--json",
    "-o",
    outputPath,
    "-C",
    projectRoot,
    "-",
    ...task.passthroughArgs,
  ];
  const command = [binary, ...args];
  const child = spawn(binary, args, {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.pid === undefined) {
    throw new Error("Failed to start background provider process.");
  }
  const logStream = createWriteStream(logPath, { flags: "a" });
  child.stdout.on("data", (chunk: Buffer) => {
    logStream.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    logStream.write(chunk);
  });
  child.on("close", async (code: number | null, signal: NodeJS.Signals | null) => {
    await writeJson(exitPath, {
      code,
      finishedAt: new Date().toISOString(),
      signal,
    } satisfies TaskExitEnvelope);
    logStream.end();
  });
  child.stdin.end(envelope);

  session.lastPrompt = task.prompt;
  session.lastProviderCommand = command;
  session.events.push({
    payload: {
      pid: child.pid,
      taskId: task.id,
    },
    timestamp: new Date().toISOString(),
    type: "agent_task_started",
  });
  await new FileSessionStore(projectRoot).save(session);

  const startedAt = new Date().toISOString();
  return {
    activeRun: {
      command,
      exitPath,
      logPath,
      outputPath,
      pid: child.pid,
      promptPath,
      runPath,
      sessionId: session.id,
      startedAt,
      taskId: task.id,
    },
    state: {
      ...markTaskRunning(state, task.id, startedAt),
      activeRun: {
        command,
        exitPath,
        logPath,
        outputPath,
        pid: child.pid,
        promptPath,
        runPath,
        sessionId: session.id,
        startedAt,
        taskId: task.id,
      },
    },
  };
}

async function finalizeBackgroundTask(
  projectRoot: string,
  config: LatteConfig,
  state: AgentDaemonState,
): Promise<AgentDaemonState> {
  if (!state.activeRun) {
    return state;
  }

  const exit = await readJson<TaskExitEnvelope | null>(state.activeRun.exitPath, null);
  if (!exit) {
    if (isPidAlive(state.activeRun.pid)) {
      return state;
    }
    return markTaskRetry(
      state,
      state.activeRun.taskId,
      "background process disappeared before writing an exit record",
      null,
      new Date().toISOString(),
    );
  }

  const task = state.tasks.find(
    (candidate) => candidate.id === state.activeRun?.taskId,
  );
  const outputBody = await readFile(state.activeRun.outputPath, "utf8").catch(
    () => "",
  );
  await new FileSessionStore(projectRoot).appendEvent(state.activeRun.sessionId, {
    payload: {
      exitCode: exit.code,
      outputPath: state.activeRun.outputPath,
      taskId: state.activeRun.taskId,
    },
    timestamp: exit.finishedAt,
    type: exit.code === 0 ? "agent_task_completed" : "agent_task_failed",
  });

  if (outputBody.trim()) {
    await new JsonMemoryStore(resolveProjectStateRoot(projectRoot)).add({
      confidence: exit.code === 0 ? 0.72 : 0.45,
      content: [
        `Task prompt: ${task?.prompt ?? "unknown"}`,
        "",
        "Outcome snapshot:",
        outputBody.slice(0, 1_200),
      ].join("\n"),
      kind: "episodic",
      metadata: {
        exitCode: exit.code,
        sessionId: state.activeRun.sessionId,
        taskId: state.activeRun.taskId,
      },
      namespace: config.namespace,
      provenance: [state.activeRun.outputPath],
    });
  }

  const inferredFailure = detectTransientFailureSignature(outputBody);
  if (inferredFailure) {
    return markTaskRetry(
      state,
      state.activeRun.taskId,
      inferredFailure,
      exit.code,
      exit.finishedAt,
    );
  }

  return exit.code === 0
    ? markTaskCompleted(state, state.activeRun.taskId, exit.finishedAt)
    : markTaskRetry(
        state,
        state.activeRun.taskId,
        `provider exited with ${exit.code ?? "unknown"}`,
        exit.code,
        exit.finishedAt,
      );
}

async function waitForDaemonReady(projectRoot: string): Promise<AgentDaemonState | null> {
  const store = new FileAgentStore(projectRoot);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await store.readState();
    if (state?.pid && isPidAlive(state.pid)) {
      return state;
    }
    await sleep(250);
  }
  return store.readState();
}

async function ensureDaemonRunning(
  projectRoot: string,
  provider?: ProviderName,
): Promise<AgentDaemonState | null> {
  const config = await loadLatteConfig(projectRoot);
  const desiredProvider = provider ?? config.providers.default;
  const store = new FileAgentStore(projectRoot);
  const state = await store.ensureState(config.namespace, desiredProvider);
  if (state.pid && isPidAlive(state.pid)) {
    return state;
  }

  const cliEntry = path.resolve(process.argv[1] ?? "");
  const child = spawn(
    process.execPath,
    [
      cliEntry,
      "agent",
      "start",
      "--project",
      projectRoot,
      "--provider",
      desiredProvider,
      "--foreground",
    ],
    {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  return waitForDaemonReady(projectRoot);
}

async function runAgentDaemon(projectRoot: string, provider?: ProviderName) {
  const config = await loadLatteConfig(projectRoot);
  const store = new FileAgentStore(projectRoot);
  let state = await store.ensureState(
    config.namespace,
    provider ?? config.providers.default,
  );
  let stopRequested = false;
  const stop = () => {
    stopRequested = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (true) {
    state = (await store.readState()) ?? state;
    const now = new Date();
    const timestamp = now.toISOString();
    state = {
      ...state,
      heartbeatAt: timestamp,
      pid: process.pid,
      provider: provider ?? state.provider,
      startedAt: state.startedAt ?? timestamp,
      status:
        state.status === "stopped" ? "starting" : state.status,
      updatedAt: timestamp,
    };

    const peers = await store.listPeerAgents(config.namespace);
    const snapshot = buildResourceSnapshot(peers.length, timestamp);
    await store.updateRegistry({
      heartbeatAt: timestamp,
      pid: process.pid,
      projectKey: config.namespace,
    });
    state = noteResourceAssessment(
      state,
      snapshot,
      assessAgentResources(snapshot, state.resourcePolicy),
    );

    for (const entry of await store.listPendingCommands()) {
      state = applyAgentCommand(state, entry.command);
      await store.acknowledgeCommand(entry.path);
    }

    if (stopRequested && state.status !== "stopping") {
      state = applyAgentCommand(
        state,
        createAgentCommand({ payload: {}, type: "stop" }),
      );
    }

    state = await finalizeBackgroundTask(projectRoot, config, state);

    if (
      !state.activeRun &&
      state.status !== "paused" &&
      state.status !== "stopping" &&
      state.lastResourceAssessment?.allowed !== false
    ) {
      const nextTask = selectRunnableTask(state, now);
      if (nextTask) {
        try {
          const launch = await launchBackgroundTask(
            projectRoot,
            config,
            state,
            nextTask,
          );
          state = launch.state;
        } catch (error) {
          state = markTaskRetry(
            state,
            nextTask.id,
            error instanceof Error ? error.message : String(error),
            null,
            new Date().toISOString(),
          );
        }
      }
    }

    if (state.status === "stopping" && !state.activeRun) {
      state = {
        ...state,
        heartbeatAt: new Date().toISOString(),
        status: "stopped",
        updatedAt: new Date().toISOString(),
      };
      await store.writeState(state);
      break;
    }

    await store.writeState(state);
    await sleep(state.resourcePolicy.pollIntervalMs);
  }
}

async function printTaskLog(projectRoot: string, lines = 20): Promise<void> {
  const state = await new FileAgentStore(projectRoot).readState();
  const logPath = state?.activeRun?.logPath;
  if (!logPath) {
    console.log("No active run log available.");
    return;
  }
  const body = await readFile(logPath, "utf8").catch(() => "");
  const tail = body.trim().split("\n").slice(-lines).join("\n");
  console.log(tail || "(log is empty)");
}

async function runAgentConsole(projectRoot: string, provider?: ProviderName) {
  const state = await ensureDaemonRunning(projectRoot, provider);
  console.log(
    JSON.stringify(
      {
        console: "ready",
        daemon: summarizeState(state),
        projectRoot,
      },
      null,
      2,
    ),
  );
  console.log(
    "Commands: status, queue, submit <prompt>, pause [reason], resume, stop, tail [lines], cancel <task-id>, quit",
  );

  const rl = createInterface({ input, output });
  const store = new FileAgentStore(projectRoot);
  try {
    while (true) {
      let line = "";
      try {
        line = (await rl.question("latte> ")).trim();
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ERR_USE_AFTER_CLOSE"
        ) {
          break;
        }
        throw error;
      }
      if (!line) {
        continue;
      }
      if (line === "quit" || line === "exit") {
        break;
      }
      if (line === "help") {
        console.log(
          "status | queue | submit <prompt> | pause [reason] | resume | stop | tail [lines] | cancel <task-id> | quit",
        );
        continue;
      }
      if (line === "status") {
        console.log(JSON.stringify(summarizeState(await store.readState()), null, 2));
        continue;
      }
      if (line === "queue") {
        const latest = await store.readState();
        console.log(
          JSON.stringify(
            latest?.tasks.map((task) => ({
              attempts: task.attempts,
              id: task.id,
              nextAttemptAt: task.nextAttemptAt,
              priority: task.priority,
              prompt: task.prompt,
              status: task.status,
            })) ?? [],
            null,
            2,
          ),
        );
        continue;
      }
      if (line.startsWith("tail")) {
        const count = Number.parseInt(line.split(/\s+/)[1] ?? "20", 10);
        await printTaskLog(projectRoot, Number.isNaN(count) ? 20 : count);
        continue;
      }
      if (line === "resume") {
        await store.enqueueCommand(createAgentCommand({ payload: {}, type: "resume" }));
        console.log("Queued resume request.");
        continue;
      }
      if (line === "stop") {
        await store.enqueueCommand(createAgentCommand({ payload: {}, type: "stop" }));
        console.log("Queued stop request.");
        continue;
      }
      if (line.startsWith("pause")) {
        const reason = line.replace(/^pause\s*/, "").trim();
        await store.enqueueCommand(
          createAgentCommand({
            payload: { reason: reason || "operator_pause" },
            type: "pause",
          }),
        );
        console.log("Queued pause request.");
        continue;
      }
      if (line.startsWith("cancel ")) {
        const taskId = line.replace(/^cancel\s+/, "").trim();
        await store.enqueueCommand(
          createAgentCommand({
            payload: { taskId },
            type: "cancel",
          }),
        );
        console.log(`Queued cancellation for ${taskId}.`);
        continue;
      }
      const prompt = line.startsWith("submit ")
        ? line.replace(/^submit\s+/, "").trim()
        : line;
      await store.enqueueCommand(
        createAgentCommand({
          payload: { prompt },
          type: "submit",
        }),
      );
      console.log("Queued prompt.");
    }
  } finally {
    rl.close();
  }
}

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
    const plan = await buildForegroundLaunchPlan(prompt, options);
    if (!options.execute || options.dryRun) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    await executeForegroundLaunchPlan(plan.command);
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
    const plan = await buildForegroundLaunchPlan(prompt, options);
    if (!options.execute || options.dryRun) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    await executeForegroundLaunchPlan(plan.command);
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

const agent = program
  .command("agent")
  .description("Background harness loop and interactive supervision");

agent
  .command("start")
  .requiredOption("--project <path>", "Target project root")
  .option("--provider <provider>", "Provider override")
  .option("--foreground", "Run the daemon in the current process")
  .action(async ({ project, provider, foreground }: AgentOptions) => {
    const projectRoot = path.resolve(project);
    if (foreground) {
      await runAgentDaemon(projectRoot, provider);
      return;
    }
    const state = await ensureDaemonRunning(projectRoot, provider);
    console.log(JSON.stringify(summarizeState(state), null, 2));
  });

agent
  .command("status")
  .requiredOption("--project <path>", "Target project root")
  .action(async ({ project }: { project: string }) => {
    const state = await new FileAgentStore(path.resolve(project)).readState();
    console.log(JSON.stringify(summarizeState(state), null, 2));
  });

agent
  .command("submit")
  .requiredOption("--project <path>", "Target project root")
  .option("--provider <provider>", "Provider override")
  .option("--priority <n>", "Higher runs first", "0")
  .option("--session-id <id>", "Attach work to a specific Latte session")
  .option("--passthrough <arg...>", "Extra provider arguments")
  .argument("<prompt...>")
  .action(
    async (
      promptParts: string[],
      {
        passthrough,
        priority,
        project,
        provider,
        sessionId,
      }: {
        passthrough?: string[];
        priority: string;
        project: string;
        provider?: ProviderName;
        sessionId?: string;
      },
    ) => {
      const projectRoot = path.resolve(project);
      await ensureDaemonRunning(projectRoot, provider);
      await new FileAgentStore(projectRoot).enqueueCommand(
        createAgentCommand({
          payload: {
            ...(passthrough ? { passthroughArgs: passthrough } : {}),
            priority: Number.parseInt(priority, 10) || 0,
            prompt: promptParts.join(" "),
            ...(provider ? { provider } : {}),
            ...(sessionId ? { sessionId } : {}),
          },
          type: "submit",
        }),
      );
      console.log("Queued prompt.");
    },
  );

agent
  .command("pause")
  .requiredOption("--project <path>", "Target project root")
  .argument("[reason...]")
  .action(async (reasonParts: string[], { project }: { project: string }) => {
    await new FileAgentStore(path.resolve(project)).enqueueCommand(
      createAgentCommand({
        payload: { reason: reasonParts.join(" ") || "operator_pause" },
        type: "pause",
      }),
    );
    console.log("Queued pause request.");
  });

agent
  .command("resume")
  .requiredOption("--project <path>", "Target project root")
  .action(async ({ project }: { project: string }) => {
    await new FileAgentStore(path.resolve(project)).enqueueCommand(
      createAgentCommand({ payload: {}, type: "resume" }),
    );
    console.log("Queued resume request.");
  });

agent
  .command("stop")
  .requiredOption("--project <path>", "Target project root")
  .action(async ({ project }: { project: string }) => {
    await new FileAgentStore(path.resolve(project)).enqueueCommand(
      createAgentCommand({ payload: {}, type: "stop" }),
    );
    console.log("Queued stop request.");
  });

agent
  .command("console")
  .requiredOption("--project <path>", "Target project root")
  .option("--provider <provider>", "Provider override")
  .action(async ({ project, provider }: AgentOptions) => {
    await runAgentConsole(path.resolve(project), provider);
  });

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

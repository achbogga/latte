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
  buildWorkspaceEvalReport,
  buildWorkspaceExecPlan,
  buildWorkspaceRestorePlan,
  compileContextPack,
  createWorkspaceSnapshot,
  createAgentCommand,
  createCacheKey,
  createStressRun,
  buildCronSchedule,
  discoverGitProjects,
  discoverWorkspaceRoot,
  detectTransientFailureSignature,
  defaultStressScenarios,
  ensureDir,
  FileAgentStore,
  FileCronStore,
  FileSessionStore,
  installWorkspaceSkill,
  inspectWorkspaceState,
  listWorkspaceSnapshots,
  JsonMemoryStore,
  loadLatteConfig,
  loadWorkspaceManifest,
  markTaskCompleted,
  markTaskRetry,
  markTaskRunning,
  noteResourceAssessment,
  parseCronSessionTarget,
  queryWorkspaceState,
  readWorkspaceSnapshot,
  readJson,
  readManagedAuth,
  reconcileAgentState,
  renderWorkspaceBrief,
  renderPromptEnvelope,
  resolveProjectStateRoot,
  runHarnessStressGauntlet,
  runWorkspaceExecPlan,
  saveManagedAuth,
  selectRunnableTask,
  sweepMemory,
  workspaceCli,
  workspaceManifestPath,
  workspaceProjects,
  writeWorkspaceManifest,
  writeJson,
  writeText,
  type AgentDaemonState,
  type AgentTask,
  type LatteConfig,
  type ProviderName,
  type SessionRecord,
  type WorkspaceFilter,
  type WorkspaceManifest,
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

type WorkspaceCommonOptions = {
  exclude?: string;
  include?: string;
  json?: boolean;
  root?: string;
  tag?: string;
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

function summarizeState(
  state: AgentDaemonState | null,
): Record<string, unknown> {
  if (!state) {
    return {
      status: "missing",
    };
  }
  const queued = state.tasks.filter((task) => task.status === "queued").length;
  const running = state.tasks.filter(
    (task) => task.status === "running",
  ).length;
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

function parseWorkspaceFilter(
  options: WorkspaceCommonOptions,
): WorkspaceFilter {
  return {
    exclude: workspaceCli.splitCsv(options.exclude),
    include: workspaceCli.splitCsv(options.include),
    tag: workspaceCli.splitCsv(options.tag),
  };
}

async function resolveWorkspaceRoot(options: {
  project?: string;
  root?: string;
}): Promise<string> {
  const startPath = path.resolve(options.project ?? process.cwd());
  const root = await discoverWorkspaceRoot(startPath, options.root);
  if (!root) {
    throw new Error(
      "No latte.workspace.yaml found. Run `latte workspace init --root <path> --discover` first.",
    );
  }
  return root;
}

function printWorkspaceState(
  state: Awaited<ReturnType<typeof inspectWorkspaceState>>,
  json?: boolean,
): void {
  if (json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log(renderWorkspaceBrief(state));
}

function printWorkspaceProjects(
  projects: ReturnType<typeof workspaceProjects>,
  json?: boolean,
): void {
  if (json) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }
  for (const project of projects) {
    const tags =
      project.tags.length > 0 ? ` tags=${project.tags.join(",")}` : "";
    console.log(`${project.name}\t${project.path}${tags}`);
  }
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
  if (task.sessionKey) {
    return sessions.getOrCreateByKey(
      config.namespace,
      task.provider,
      cacheKey,
      task.sessionKey,
      {
        origin: task.origin ?? { kind: "manual" },
      },
    );
  }
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
        session.projectKey === config.namespace &&
        session.provider === task.provider,
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

  const workspaceRoot = await discoverWorkspaceRoot(projectRoot).catch(
    () => null,
  );
  if (workspaceRoot) {
    const workspaceState = await inspectWorkspaceState(workspaceRoot).catch(
      () => null,
    );
    if (workspaceState) {
      sections.push(
        "",
        "## Workspace context",
        renderWorkspaceBrief(workspaceState, projectRoot),
      );
    }
    const workspaceSkill = await readFile(
      path.join(workspaceRoot, ".latte", "skills", "gitkb-workspace-alpha.md"),
      "utf8",
    ).catch(() => null);
    if (workspaceSkill) {
      sections.push(
        "",
        "## Workspace skill",
        workspaceSkill.trim().slice(0, 2_000),
      );
    }
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
  const session = await resolveSessionForTask(
    projectRoot,
    config,
    task,
    cacheKey,
  );
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
  child.on(
    "close",
    async (code: number | null, signal: NodeJS.Signals | null) => {
      await writeJson(exitPath, {
        code,
        finishedAt: new Date().toISOString(),
        signal,
      } satisfies TaskExitEnvelope);
      logStream.end();
    },
  );
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

  const exit = await readJson<TaskExitEnvelope | null>(
    state.activeRun.exitPath,
    null,
  );
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
  await new FileSessionStore(projectRoot).appendEvent(
    state.activeRun.sessionId,
    {
      payload: {
        exitCode: exit.code,
        outputPath: state.activeRun.outputPath,
        taskId: state.activeRun.taskId,
      },
      timestamp: exit.finishedAt,
      type: exit.code === 0 ? "agent_task_completed" : "agent_task_failed",
    },
  );

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

async function waitForDaemonReady(
  projectRoot: string,
): Promise<AgentDaemonState | null> {
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
  const cronStore = new FileCronStore(projectRoot);
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
      status: state.status === "stopped" ? "starting" : state.status,
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
    state = reconcileAgentState(state, now);
    await cronStore.reconcileWithAgentState(state);

    if (
      !state.activeRun &&
      state.status !== "paused" &&
      state.status !== "stopping" &&
      state.lastResourceAssessment?.allowed !== false
    ) {
      if (process.env.LATTE_SKIP_CRON !== "1") {
        state = (
          await cronStore.enqueueDueJobs(state, {
            now,
            projectKey: config.namespace,
            provider: state.provider,
          })
        ).state;
      }
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
        console.log(
          JSON.stringify(summarizeState(await store.readState()), null, 2),
        );
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
        await store.enqueueCommand(
          createAgentCommand({ payload: {}, type: "resume" }),
        );
        console.log("Queued resume request.");
        continue;
      }
      if (line === "stop") {
        await store.enqueueCommand(
          createAgentCommand({ payload: {}, type: "stop" }),
        );
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

memory
  .command("sweep")
  .requiredOption("--project <path>", "Target project root")
  .option("--max-promoted <n>", "Maximum memories to promote", "40")
  .option("--min-score <n>", "Promotion score threshold", "0.4")
  .action(
    async ({
      maxPromoted,
      minScore,
      project,
    }: {
      maxPromoted: string;
      minScore: string;
      project: string;
    }) => {
      const projectRoot = path.resolve(project);
      const config = await loadLatteConfig(projectRoot);
      const report = await sweepMemory(
        resolveProjectStateRoot(projectRoot),
        config.namespace,
        {
          maxPromoted: Number.parseInt(maxPromoted, 10) || 40,
          minScore: Number.parseFloat(minScore),
        },
      );
      console.log(JSON.stringify(report, null, 2));
    },
  );

const sessionsCommand = program
  .command("sessions")
  .description("Inspect durable Latte sessions");

sessionsCommand
  .command("list")
  .requiredOption("--project <path>", "Target project root")
  .option("--json", "Print JSON")
  .action(async ({ json, project }: { json?: boolean; project: string }) => {
    const sessions = await new FileSessionStore(path.resolve(project)).list();
    if (json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    for (const session of sessions) {
      console.log(
        `${session.id}\t${session.sessionKey ?? "-"}\t${session.provider}\t${session.updatedAt}`,
      );
    }
  });

sessionsCommand
  .command("show")
  .requiredOption("--project <path>", "Target project root")
  .argument("<idOrKey>")
  .action(async (idOrKey: string, { project }: { project: string }) => {
    const store = new FileSessionStore(path.resolve(project));
    const session =
      (await store.get(idOrKey)) ?? (await store.getByKey(idOrKey));
    if (!session) {
      throw new Error(`Session not found: ${idOrKey}`);
    }
    console.log(JSON.stringify(session, null, 2));
  });

sessionsCommand
  .command("compact")
  .requiredOption("--project <path>", "Target project root")
  .argument("<idOrKey>")
  .action(async (idOrKey: string, { project }: { project: string }) => {
    const projectRoot = path.resolve(project);
    const config = await loadLatteConfig(projectRoot);
    const sessions = new FileSessionStore(projectRoot);
    const session =
      (await sessions.get(idOrKey)) ?? (await sessions.getByKey(idOrKey));
    if (!session) {
      throw new Error(`Session not found: ${idOrKey}`);
    }
    const summary = session.events
      .slice(-20)
      .map(
        (event) =>
          `${event.timestamp} ${event.type}: ${JSON.stringify(event.payload)}`,
      )
      .join("\n");
    const memory = await new JsonMemoryStore(
      resolveProjectStateRoot(projectRoot),
    ).add({
      confidence: 0.65,
      content: [
        `Session compacted: ${session.sessionKey ?? session.id}`,
        "",
        summary,
      ].join("\n"),
      kind: "episodic",
      metadata: {
        sessionId: session.id,
        sessionKey: session.sessionKey ?? null,
      },
      namespace: config.namespace,
      provenance: ["latte sessions compact"],
    });
    await sessions.appendEvent(session.id, {
      payload: { memoryId: memory.id },
      timestamp: new Date().toISOString(),
      type: "session_compacted_to_memory",
    });
    console.log(JSON.stringify(memory, null, 2));
  });

const cron = program
  .command("cron")
  .description("Durable scheduled agent jobs");

cron
  .command("add")
  .requiredOption("--project <path>", "Target project root")
  .requiredOption("--name <name>", "Job name")
  .option("--at <iso>", "One-shot timestamp")
  .option("--every <duration>", "Fixed interval, e.g. 30m or 6h")
  .option("--session <target>", "main, isolated, or session:<key>", "isolated")
  .option("--provider <provider>", "Provider override")
  .option("--tag <tags>", "Comma-separated tags")
  .option("--delete-after-run", "Delete one-shot job after successful run")
  .argument("<prompt...>")
  .action(
    async (
      promptParts: string[],
      {
        at,
        deleteAfterRun,
        every,
        name,
        project,
        provider,
        session,
        tag,
      }: {
        at?: string;
        deleteAfterRun?: boolean;
        every?: string;
        name: string;
        project: string;
        provider?: ProviderName;
        session: string;
        tag?: string;
      },
    ) => {
      const store = new FileCronStore(path.resolve(project));
      const scheduleInput: { at?: string; every?: string } = {};
      if (at) {
        scheduleInput.at = at;
      }
      if (every) {
        scheduleInput.every = every;
      }
      const options: {
        deleteAfterRun?: boolean;
        name: string;
        prompt: string;
        provider?: ProviderName;
        schedule: ReturnType<typeof buildCronSchedule>;
        sessionTarget: ReturnType<typeof parseCronSessionTarget>;
        tags?: string[];
      } = {
        name,
        prompt: promptParts.join(" "),
        schedule: buildCronSchedule(scheduleInput),
        sessionTarget: parseCronSessionTarget(session),
      };
      if (deleteAfterRun !== undefined) {
        options.deleteAfterRun = deleteAfterRun;
      }
      if (provider) {
        options.provider = provider;
      }
      const tags = workspaceCli.splitCsv(tag);
      if (tags) {
        options.tags = tags;
      }
      console.log(JSON.stringify(await store.addJob(options), null, 2));
    },
  );

cron
  .command("list")
  .requiredOption("--project <path>", "Target project root")
  .option("--json", "Print JSON")
  .action(async ({ json, project }: { json?: boolean; project: string }) => {
    const jobs = await new FileCronStore(path.resolve(project)).listJobs();
    if (json) {
      console.log(JSON.stringify(jobs, null, 2));
      return;
    }
    for (const job of jobs) {
      console.log(
        `${job.id}\t${job.enabled ? "enabled" : "disabled"}\t${job.nextRunAt}\t${job.name}`,
      );
    }
  });

cron
  .command("run")
  .requiredOption("--project <path>", "Target project root")
  .argument("<jobId>")
  .action(async (jobId: string, { project }: { project: string }) => {
    const projectRoot = path.resolve(project);
    const store = new FileCronStore(projectRoot);
    const job = await store.forceDue(jobId);
    if (!job) {
      throw new Error(`Cron job not found: ${jobId}`);
    }
    await ensureDaemonRunning(projectRoot);
    console.log(JSON.stringify(job, null, 2));
  });

cron
  .command("runs")
  .requiredOption("--project <path>", "Target project root")
  .option("--id <jobId>", "Filter by job id")
  .action(async ({ id, project }: { id?: string; project: string }) => {
    console.log(
      JSON.stringify(
        await new FileCronStore(path.resolve(project)).listRuns(id),
        null,
        2,
      ),
    );
  });

cron
  .command("remove")
  .requiredOption("--project <path>", "Target project root")
  .argument("<jobId>")
  .action(async (jobId: string, { project }: { project: string }) => {
    const removed = await new FileCronStore(path.resolve(project)).removeJob(
      jobId,
    );
    console.log(JSON.stringify({ jobId, removed }, null, 2));
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

stress
  .command("extreme")
  .requiredOption("--project <path>", "Target project root")
  .action(async ({ project }: { project: string }) => {
    const projectRoot = path.resolve(project);
    const config = await loadLatteConfig(projectRoot);
    const report = await runHarnessStressGauntlet(
      projectRoot,
      config.namespace,
      config.providers.default,
    );
    console.log(JSON.stringify(report, null, 2));
    if (report.summary.failed > 0) {
      process.exitCode = 1;
    }
  });

const workspace = program
  .command("workspace")
  .description("GitKB-inspired multi-repo workspace alpha");

workspace
  .command("init")
  .option("--root <path>", "Workspace root", process.cwd())
  .option("--discover", "Discover git repos under the root")
  .option("--include <repos>", "Comma-separated repo names to include")
  .action(
    async ({
      discover,
      include,
      root,
    }: {
      discover?: boolean;
      include?: string;
      root: string;
    }) => {
      const workspaceRoot = path.resolve(root);
      const projects = discover
        ? await discoverGitProjects(
            workspaceRoot,
            workspaceCli.splitCsv(include),
          )
        : {};
      const manifest: WorkspaceManifest = {
        generatedAt: new Date().toISOString(),
        projects,
        schemaVersion: "0.1-alpha",
      };
      await writeWorkspaceManifest(workspaceRoot, manifest);
      console.log(
        JSON.stringify(
          {
            manifestPath: workspaceManifestPath(workspaceRoot),
            projectCount: Object.keys(projects).length,
            projects: Object.keys(projects).sort(),
          },
          null,
          2,
        ),
      );
    },
  );

workspace
  .command("list")
  .option("--root <path>", "Workspace root")
  .option("--json", "Print JSON")
  .action(async (options: WorkspaceCommonOptions) => {
    const workspaceRoot = await resolveWorkspaceRoot(options);
    const manifest = await loadWorkspaceManifest(workspaceRoot);
    printWorkspaceProjects(workspaceProjects(manifest), options.json);
  });

workspace
  .command("status")
  .option("--root <path>", "Workspace root")
  .option("--include <repos>", "Comma-separated repo names to include")
  .option("--exclude <repos>", "Comma-separated repo names to exclude")
  .option("--tag <tags>", "Comma-separated tags to include")
  .option("--json", "Print JSON")
  .action(async (options: WorkspaceCommonOptions) => {
    const workspaceRoot = await resolveWorkspaceRoot(options);
    const state = await inspectWorkspaceState(
      workspaceRoot,
      parseWorkspaceFilter(options),
    );
    printWorkspaceState(state, options.json);
  });

workspace
  .command("query")
  .option("--root <path>", "Workspace root")
  .option("--include <repos>", "Comma-separated repo names to include")
  .option("--exclude <repos>", "Comma-separated repo names to exclude")
  .option("--tag <tags>", "Comma-separated tags to include")
  .option("--json", "Print JSON")
  .argument("<expression...>")
  .action(
    async (expressionParts: string[], options: WorkspaceCommonOptions) => {
      const workspaceRoot = await resolveWorkspaceRoot(options);
      const state = await inspectWorkspaceState(
        workspaceRoot,
        parseWorkspaceFilter(options),
      );
      const results = queryWorkspaceState(state, expressionParts.join(" "));
      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      for (const project of results) {
        console.log(`${project.name}\t${project.path}`);
      }
    },
  );

workspace
  .command("exec")
  .option("--root <path>", "Workspace root")
  .option("--include <repos>", "Comma-separated repo names to include")
  .option("--exclude <repos>", "Comma-separated repo names to exclude")
  .option("--tag <tags>", "Comma-separated tags to include")
  .option("--dry-run", "Print the execution plan without running commands")
  .option(
    "--allow-write",
    "Allow mutating commands when paired with a snapshot",
  )
  .option("--snapshot <name>", "Required snapshot name for mutating commands")
  .allowUnknownOption(true)
  .argument("<command...>")
  .action(
    async (
      commandParts: string[],
      options: WorkspaceCommonOptions & {
        allowWrite?: boolean;
        dryRun?: boolean;
        snapshot?: string;
      },
    ) => {
      const command = commandParts.filter((part) => part !== "--");
      if (command.length === 0) {
        throw new Error(
          "Missing command. Use `latte workspace exec -- <cmd>`.",
        );
      }
      const workspaceRoot = await resolveWorkspaceRoot(options);
      const execOptions: {
        allowWrite?: boolean;
        dryRun?: boolean;
        snapshot?: string;
      } = {};
      if (options.allowWrite !== undefined) {
        execOptions.allowWrite = options.allowWrite;
      }
      if (options.dryRun !== undefined) {
        execOptions.dryRun = options.dryRun;
      }
      if (options.snapshot !== undefined) {
        execOptions.snapshot = options.snapshot;
      }
      const plan = await buildWorkspaceExecPlan(
        workspaceRoot,
        command,
        parseWorkspaceFilter(options),
        execOptions,
      );
      if (plan.mutating && options.allowWrite && options.snapshot) {
        const snapshot = await readWorkspaceSnapshot(
          workspaceRoot,
          options.snapshot,
        );
        if (!snapshot) {
          throw new Error(
            `Snapshot ${options.snapshot} not found. Run \`latte workspace snapshot create ${options.snapshot}\` first.`,
          );
        }
      }
      if (plan.dryRun) {
        console.log(JSON.stringify({ plan, results: [] }, null, 2));
        return;
      }
      const results = runWorkspaceExecPlan(plan);
      console.log(JSON.stringify({ plan, results }, null, 2));
      if (results.some((result) => result.exitCode !== 0)) {
        process.exitCode = 1;
      }
    },
  );

const workspaceSnapshot = workspace
  .command("snapshot")
  .description("Capture and inspect workspace git heads");

workspaceSnapshot
  .command("create")
  .option("--root <path>", "Workspace root")
  .option("--include <repos>", "Comma-separated repo names to include")
  .option("--exclude <repos>", "Comma-separated repo names to exclude")
  .option("--tag <tags>", "Comma-separated tags to include")
  .argument("<name>")
  .action(async (name: string, options: WorkspaceCommonOptions) => {
    const workspaceRoot = await resolveWorkspaceRoot(options);
    const snapshot = await createWorkspaceSnapshot(
      workspaceRoot,
      name,
      parseWorkspaceFilter(options),
    );
    console.log(JSON.stringify(snapshot, null, 2));
  });

workspaceSnapshot
  .command("list")
  .option("--root <path>", "Workspace root")
  .action(async (options: WorkspaceCommonOptions) => {
    const workspaceRoot = await resolveWorkspaceRoot(options);
    console.log(
      JSON.stringify(await listWorkspaceSnapshots(workspaceRoot), null, 2),
    );
  });

workspaceSnapshot
  .command("show")
  .option("--root <path>", "Workspace root")
  .argument("<name>")
  .action(async (name: string, options: WorkspaceCommonOptions) => {
    const workspaceRoot = await resolveWorkspaceRoot(options);
    const snapshot = await readWorkspaceSnapshot(workspaceRoot, name);
    if (!snapshot) {
      throw new Error(`Snapshot ${name} not found.`);
    }
    console.log(JSON.stringify(snapshot, null, 2));
  });

workspaceSnapshot
  .command("restore")
  .option("--root <path>", "Workspace root")
  .option("--allow-restore", "Execute git checkout commands")
  .argument("<name>")
  .action(
    async (
      name: string,
      options: WorkspaceCommonOptions & { allowRestore?: boolean },
    ) => {
      const workspaceRoot = await resolveWorkspaceRoot(options);
      const snapshot = await readWorkspaceSnapshot(workspaceRoot, name);
      if (!snapshot) {
        throw new Error(`Snapshot ${name} not found.`);
      }
      const plan = buildWorkspaceRestorePlan(snapshot);
      if (!options.allowRestore) {
        console.log(JSON.stringify({ plan, results: [] }, null, 2));
        return;
      }
      const executablePlan = { ...plan, dryRun: false };
      const results = runWorkspaceExecPlan(executablePlan);
      console.log(JSON.stringify({ plan: executablePlan, results }, null, 2));
      if (results.some((result) => result.exitCode !== 0)) {
        process.exitCode = 1;
      }
    },
  );

workspace
  .command("brief")
  .option("--root <path>", "Workspace root")
  .option("--for-repo <name>", "Mark a workspace repo as current")
  .action(async ({ forRepo, root }: { forRepo?: string; root?: string }) => {
    const workspaceRoot = await resolveWorkspaceRoot(root ? { root } : {});
    const state = await inspectWorkspaceState(workspaceRoot);
    const current = forRepo
      ? state.projects.find((project) => project.name === forRepo)?.path
      : process.cwd();
    console.log(renderWorkspaceBrief(state, current));
  });

const workspaceSkill = workspace
  .command("skill")
  .description("Install alpha workspace skills");

workspaceSkill
  .command("install")
  .option("--root <path>", "Workspace root")
  .action(async (options: WorkspaceCommonOptions) => {
    const workspaceRoot = await resolveWorkspaceRoot(options);
    console.log(await installWorkspaceSkill(workspaceRoot));
  });

const workspaceEval = workspace
  .command("eval")
  .description("Run workspace usefulness evaluations");

workspaceEval
  .command("gitkb-alpha")
  .option("--root <path>", "Workspace root")
  .action(async (options: WorkspaceCommonOptions) => {
    const workspaceRoot = await resolveWorkspaceRoot(options);
    console.log(
      JSON.stringify(await buildWorkspaceEvalReport(workspaceRoot), null, 2),
    );
  });

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

import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureDir, readJson, writeJson } from "./fs.js";
import { resolveLatteHome, resolveProjectStateRoot } from "./session.js";
import type {
  AgentCommand,
  AgentDaemonState,
  AgentRegistryEntry,
  AgentResourceAssessment,
  AgentResourcePolicy,
  AgentResourceSnapshot,
  AgentTask,
  ProviderName,
  SessionEvent,
} from "./types.js";

type AgentCommandInput =
  | {
      payload: {
        passthroughArgs?: string[];
        priority?: number;
        prompt: string;
        provider?: ProviderName;
        sessionId?: string;
      };
      type: "submit";
    }
  | {
      payload: {
        taskId: string;
      };
      type: "cancel";
    }
  | {
      payload: {
        reason?: string;
      };
      type: "pause";
    }
  | {
      payload: Record<string, never>;
      type: "resume";
    }
  | {
      payload: Record<string, never>;
      type: "stop";
    };

export function buildDefaultResourcePolicy(
  cpuCount = os.cpus().length || 1,
): AgentResourcePolicy {
  return {
    heartbeatTtlMs: 15_000,
    maxPeerAgents: cpuCount >= 16 ? 2 : 1,
    maxRetryBackoffMs: 120_000,
    maxTaskAttempts: 4,
    maxTrackedEvents: 80,
    maxTrackedFinishedTasks: 40,
    minFreeMemoryRatio: 0.2,
    peerLoadPenalty: 0.12,
    pollIntervalMs: 2_500,
    retryBackoffMs: 7_500,
    softLoadPerCpu: 0.75,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function appendEvent(
  events: SessionEvent[],
  event: SessionEvent,
  maxTrackedEvents: number,
): SessionEvent[] {
  return [...events, event].slice(-maxTrackedEvents);
}

function sortTasks(tasks: AgentTask[]): AgentTask[] {
  return [...tasks].sort((left, right) => {
    if (left.status === "running" && right.status !== "running") {
      return -1;
    }
    if (left.status !== "running" && right.status === "running") {
      return 1;
    }
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
}

function pruneTasks(
  tasks: AgentTask[],
  maxTrackedFinishedTasks: number,
): AgentTask[] {
  const active = tasks.filter(
    (task) => task.status === "queued" || task.status === "running",
  );
  const finished = tasks
    .filter(
      (task) =>
        task.status === "cancelled" ||
        task.status === "completed" ||
        task.status === "failed",
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, maxTrackedFinishedTasks);
  return sortTasks([...active, ...finished]);
}

function backoffMs(policy: AgentResourcePolicy, attempts: number): number {
  const raw = policy.retryBackoffMs * 2 ** Math.max(attempts - 1, 0);
  return Math.min(raw, policy.maxRetryBackoffMs);
}

export function createAgentCommand(
  command: AgentCommandInput,
): AgentCommand {
  return {
    ...command,
    createdAt: nowIso(),
    id: randomUUID(),
  } as AgentCommand;
}

export function buildDefaultDaemonState(
  projectKey: string,
  provider: ProviderName,
  policy = buildDefaultResourcePolicy(),
): AgentDaemonState {
  const timestamp = nowIso();
  return {
    appliedCommandIds: [],
    createdAt: timestamp,
    events: [],
    heartbeatAt: timestamp,
    projectKey,
    provider,
    resourcePolicy: policy,
    startedAt: timestamp,
    status: "starting",
    tasks: [],
    updatedAt: timestamp,
  };
}

export function buildResourceSnapshot(
  peerAgentCount: number,
  sampledAt = nowIso(),
): AgentResourceSnapshot {
  const cpuCount = os.cpus().length || 1;
  const [rawLoad1 = 0, rawLoad5 = 0, rawLoad15 = 0] = os.loadavg();
  const freeMemoryBytes = os.freemem();
  const totalMemoryBytes = os.totalmem();
  return {
    cpuCount,
    freeMemoryBytes,
    freeMemoryRatio:
      totalMemoryBytes > 0 ? freeMemoryBytes / totalMemoryBytes : 0,
    load1: rawLoad1,
    load15: rawLoad15,
    load5: rawLoad5,
    peerAgentCount,
    sampledAt,
  };
}

export function assessAgentResources(
  snapshot: AgentResourceSnapshot,
  policy: AgentResourcePolicy,
): AgentResourceAssessment {
  const reasons: string[] = [];
  const perCpuLoad = snapshot.load1 / Math.max(snapshot.cpuCount, 1);
  const allowedLoad = Math.max(
    0.2,
    policy.softLoadPerCpu - snapshot.peerAgentCount * policy.peerLoadPenalty,
  );
  if (snapshot.freeMemoryRatio < policy.minFreeMemoryRatio) {
    reasons.push(
      `low free memory (${(snapshot.freeMemoryRatio * 100).toFixed(1)}%)`,
    );
  }
  if (snapshot.peerAgentCount > policy.maxPeerAgents) {
    reasons.push(`too many peer Latte agents (${snapshot.peerAgentCount})`);
  }
  if (perCpuLoad > allowedLoad) {
    reasons.push(
      `load per cpu ${perCpuLoad.toFixed(2)} exceeds ${allowedLoad.toFixed(2)}`,
    );
  }
  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

export function detectTransientFailureSignature(
  outputBody: string,
): string | null {
  const normalized = outputBody.toLowerCase();
  if (
    normalized.includes("bwrap:") ||
    normalized.includes("failed rtm_newaddr") ||
    normalized.includes("operation not permitted")
  ) {
    return "provider sandbox failure";
  }
  if (normalized.includes("rate limit")) {
    return "provider rate limit";
  }
  if (normalized.includes("timed out")) {
    return "provider timeout";
  }
  return null;
}

export function isHeartbeatFresh(
  state: AgentDaemonState,
  now: Date,
): boolean {
  return (
    now.getTime() - new Date(state.heartbeatAt).getTime() <=
    state.resourcePolicy.heartbeatTtlMs
  );
}

export function selectRunnableTask(
  state: AgentDaemonState,
  at = new Date(),
): AgentTask | null {
  const atIso = at.toISOString();
  return (
    sortTasks(state.tasks).find(
      (task) => task.status === "queued" && task.nextAttemptAt <= atIso,
    ) ?? null
  );
}

export function applyAgentCommand(
  state: AgentDaemonState,
  command: AgentCommand,
): AgentDaemonState {
  if (state.appliedCommandIds.includes(command.id)) {
    return state;
  }
  const timestamp = command.createdAt;
  let next: AgentDaemonState = {
    ...state,
    appliedCommandIds: [...state.appliedCommandIds, command.id].slice(-200),
    updatedAt: timestamp,
  };

  if (command.type === "submit") {
    const task: AgentTask = {
      attempts: 0,
      createdAt: timestamp,
      id: randomUUID(),
      nextAttemptAt: timestamp,
      passthroughArgs: command.payload.passthroughArgs ?? [],
      priority: command.payload.priority ?? 0,
      prompt: command.payload.prompt.trim(),
      provider: command.payload.provider ?? state.provider,
      sessionId: command.payload.sessionId,
      status: "queued",
      updatedAt: timestamp,
    };
    next = {
      ...next,
      events: appendEvent(
        next.events,
        {
          payload: {
            priority: task.priority,
            provider: task.provider,
            taskId: task.id,
          },
          timestamp,
          type: "task_enqueued",
        },
        next.resourcePolicy.maxTrackedEvents,
      ),
      status: next.status === "paused" ? next.status : "idle",
      tasks: pruneTasks(
        [...next.tasks, task],
        next.resourcePolicy.maxTrackedFinishedTasks,
      ),
    };
    return next;
  }

  if (command.type === "cancel") {
    next = {
      ...next,
      tasks: pruneTasks(
        next.tasks.map((task) =>
          task.id === command.payload.taskId && task.status === "queued"
            ? {
                ...task,
                completedAt: timestamp,
                status: "cancelled",
                updatedAt: timestamp,
              }
            : task,
        ),
        next.resourcePolicy.maxTrackedFinishedTasks,
      ),
      events: appendEvent(
        next.events,
        {
          payload: { taskId: command.payload.taskId },
          timestamp,
          type: "task_cancelled",
        },
        next.resourcePolicy.maxTrackedEvents,
      ),
    };
    return next;
  }

  if (command.type === "pause") {
    return {
      ...next,
      events: appendEvent(
        next.events,
        {
          payload: { reason: command.payload.reason ?? "operator_pause" },
          timestamp,
          type: "daemon_paused",
        },
        next.resourcePolicy.maxTrackedEvents,
      ),
      pauseReason: command.payload.reason ?? "operator_pause",
      status: "paused",
    };
  }

  if (command.type === "resume") {
    return {
      ...next,
      events: appendEvent(
        next.events,
        {
          payload: {},
          timestamp,
          type: "daemon_resumed",
        },
        next.resourcePolicy.maxTrackedEvents,
      ),
      pauseReason: undefined,
      status: "idle",
    };
  }

  return {
    ...next,
    events: appendEvent(
      next.events,
      {
        payload: {},
        timestamp,
        type: "daemon_stop_requested",
      },
      next.resourcePolicy.maxTrackedEvents,
    ),
    status: "stopping",
  };
}

export function markTaskRunning(
  state: AgentDaemonState,
  taskId: string,
  startedAt = nowIso(),
): AgentDaemonState {
  return {
    ...state,
    events: appendEvent(
      state.events,
      {
        payload: { taskId },
        timestamp: startedAt,
        type: "task_started",
      },
      state.resourcePolicy.maxTrackedEvents,
    ),
    status: "running",
    tasks: sortTasks(
      state.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              attempts: task.attempts + 1,
              startedAt,
              status: "running",
              updatedAt: startedAt,
            }
          : task,
      ),
    ),
    updatedAt: startedAt,
  };
}

export function markTaskCompleted(
  state: AgentDaemonState,
  taskId: string,
  completedAt = nowIso(),
): AgentDaemonState {
  return {
    ...state,
    activeRun: undefined,
    events: appendEvent(
      state.events,
      {
        payload: { taskId },
        timestamp: completedAt,
        type: "task_completed",
      },
      state.resourcePolicy.maxTrackedEvents,
    ),
    lastError: undefined,
    status: "idle",
    tasks: pruneTasks(
      state.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              completedAt,
              status: "completed",
              updatedAt: completedAt,
            }
          : task,
      ),
      state.resourcePolicy.maxTrackedFinishedTasks,
    ),
    updatedAt: completedAt,
  };
}

export function markTaskRetry(
  state: AgentDaemonState,
  taskId: string,
  error: string,
  exitCode: number | null,
  failedAt = nowIso(),
): AgentDaemonState {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    return state;
  }
  const attempts = task.attempts;
  const shouldFail = attempts >= state.resourcePolicy.maxTaskAttempts;
  const nextAttemptAt = new Date(
    new Date(failedAt).getTime() +
      backoffMs(state.resourcePolicy, Math.max(attempts, 1)),
  ).toISOString();
  return {
    ...state,
    activeRun: undefined,
    events: appendEvent(
      state.events,
      {
        payload: {
          exitCode,
          nextAttemptAt: shouldFail ? null : nextAttemptAt,
          taskId,
        },
        timestamp: failedAt,
        type: shouldFail ? "task_failed" : "task_requeued",
      },
      state.resourcePolicy.maxTrackedEvents,
    ),
    lastError: error,
    status: shouldFail ? "idle" : "backing_off",
    tasks: pruneTasks(
      state.tasks.map((candidate) =>
        candidate.id === taskId
          ? {
              ...candidate,
              completedAt: shouldFail ? failedAt : undefined,
              lastError: error,
              lastExitCode: exitCode,
              nextAttemptAt: shouldFail ? candidate.nextAttemptAt : nextAttemptAt,
              status: shouldFail ? "failed" : "queued",
              updatedAt: failedAt,
            }
          : candidate,
      ),
      state.resourcePolicy.maxTrackedFinishedTasks,
    ),
    updatedAt: failedAt,
  };
}

export function noteResourceAssessment(
  state: AgentDaemonState,
  snapshot: AgentResourceSnapshot,
  assessment: AgentResourceAssessment,
): AgentDaemonState {
  const timestamp = snapshot.sampledAt;
  const nextStatus =
    state.status === "paused" || state.status === "stopping"
      ? state.status
      : assessment.allowed
        ? state.activeRun
          ? "running"
          : "idle"
        : "backing_off";
  const shouldEmitEvent =
    assessment.reasons.join("|") !==
    (state.lastResourceAssessment?.reasons.join("|") ?? "");
  return {
    ...state,
    events: shouldEmitEvent
      ? appendEvent(
          state.events,
          {
            payload: {
              allowed: assessment.allowed,
              reasons: assessment.reasons,
            },
            timestamp,
            type: assessment.allowed ? "resources_available" : "resource_backoff",
          },
          state.resourcePolicy.maxTrackedEvents,
        )
      : state.events,
    heartbeatAt: timestamp,
    lastResourceAssessment: assessment,
    lastResourceSnapshot: snapshot,
    status: nextStatus,
    updatedAt: timestamp,
  };
}

export class FileAgentStore {
  constructor(private readonly projectRoot: string) {}

  private get agentRoot(): string {
    return path.join(resolveProjectStateRoot(this.projectRoot), "agent");
  }

  private get inboxRoot(): string {
    return path.join(this.agentRoot, "inbox");
  }

  private get registryPath(): string {
    return path.join(resolveLatteHome(), "agent-registry.json");
  }

  private get statePath(): string {
    return path.join(this.agentRoot, "state.json");
  }

  async ensureState(
    projectKey: string,
    provider: ProviderName,
    policy = buildDefaultResourcePolicy(),
  ): Promise<AgentDaemonState> {
    const current = await this.readState();
    if (current) {
      return current;
    }
    const initial = buildDefaultDaemonState(projectKey, provider, policy);
    await this.writeState(initial);
    return initial;
  }

  async readState(): Promise<AgentDaemonState | null> {
    return readJson<AgentDaemonState | null>(this.statePath, null);
  }

  async writeState(state: AgentDaemonState): Promise<void> {
    await writeJson(this.statePath, state);
  }

  async enqueueCommand(command: AgentCommand): Promise<string> {
    await ensureDir(this.inboxRoot);
    const fileName = `${command.createdAt.replaceAll(/[:.]/g, "-")}-${command.id}.json`;
    const filePath = path.join(this.inboxRoot, fileName);
    await writeJson(filePath, command);
    return filePath;
  }

  async listPendingCommands(): Promise<Array<{ command: AgentCommand; path: string }>> {
    await ensureDir(this.inboxRoot);
    const entries = (await readdir(this.inboxRoot))
      .filter((entry) => entry.endsWith(".json"))
      .sort();
    const commands: Array<{ command: AgentCommand; path: string }> = [];
    for (const entry of entries) {
      const commandPath = path.join(this.inboxRoot, entry);
      const command = await readJson<AgentCommand | null>(commandPath, null);
      if (command) {
        commands.push({ command, path: commandPath });
      }
    }
    return commands;
  }

  async acknowledgeCommand(commandPath: string): Promise<void> {
    await rm(commandPath, { force: true });
  }

  async updateRegistry(entry: AgentRegistryEntry): Promise<AgentRegistryEntry[]> {
    const current = await readJson<AgentRegistryEntry[]>(this.registryPath, []);
    const next = current
      .filter((candidate) => candidate.projectKey !== entry.projectKey)
      .concat(entry);
    await writeJson(this.registryPath, next);
    return next;
  }

  async listPeerAgents(selfProjectKey: string): Promise<AgentRegistryEntry[]> {
    const current = await readJson<AgentRegistryEntry[]>(this.registryPath, []);
    const now = Date.now();
    const live = current.filter(
      (entry) =>
        now - new Date(entry.heartbeatAt).getTime() <=
        buildDefaultResourcePolicy().heartbeatTtlMs * 2,
    );
    if (live.length !== current.length) {
      await writeJson(this.registryPath, live);
    }
    return live.filter((entry) => entry.projectKey !== selfProjectKey);
  }
}

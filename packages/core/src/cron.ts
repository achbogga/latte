import { randomUUID } from "node:crypto";
import path from "node:path";

import { enqueueAgentTaskWithResult } from "./agent.js";
import { ensureDir, readJson, updateJson, writeJson } from "./fs.js";
import { resolveProjectStateRoot } from "./session.js";
import type {
  AgentDaemonState,
  CronJob,
  CronRunRecord,
  CronSchedule,
  CronSessionTarget,
  CronState,
  CronTickResult,
  ProviderName,
} from "./types.js";

const maxRetainedCronRuns = 500;

function nowIso(): string {
  return new Date().toISOString();
}

export function parseDurationMs(value: string): number {
  const match = value.trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!match) {
    throw new Error(`Invalid duration: ${value}`);
  }
  const amount = Number.parseInt(match[1] ?? "0", 10);
  const unit = (match[2] ?? "ms").toLowerCase();
  const multipliers: Record<string, number> = {
    d: 86_400_000,
    h: 3_600_000,
    m: 60_000,
    ms: 1,
    s: 1_000,
  };
  return amount * (multipliers[unit] ?? 1);
}

export function buildCronSchedule(input: {
  at?: string;
  every?: string;
}): CronSchedule {
  if (input.at) {
    return {
      at: new Date(input.at).toISOString(),
      kind: "at",
    };
  }
  if (input.every) {
    return {
      everyMs: parseDurationMs(input.every),
      kind: "interval",
    };
  }
  throw new Error("Cron jobs require --at or --every.");
}

export function parseCronSessionTarget(value: string): CronSessionTarget {
  if (value === "main") {
    return { kind: "main" };
  }
  if (value === "isolated") {
    return { kind: "isolated" };
  }
  if (value.startsWith("session:")) {
    const key = value.replace(/^session:/, "").trim();
    if (!key) {
      throw new Error("Named cron sessions require session:<key>.");
    }
    return { key, kind: "named" };
  }
  throw new Error("Session target must be main, isolated, or session:<key>.");
}

function nextRunAfter(schedule: CronSchedule, now: Date): string {
  if (schedule.kind === "at") {
    return schedule.at;
  }
  return new Date(now.getTime() + schedule.everyMs).toISOString();
}

function sessionKeyForRun(job: CronJob, runId: string): string {
  if (job.sessionTarget.kind === "main") {
    return "main";
  }
  if (job.sessionTarget.kind === "named") {
    return job.sessionTarget.key;
  }
  return `cron:${job.id}:${runId}`;
}

function isTerminalRun(run: CronRunRecord): boolean {
  return (
    run.status === "failed" ||
    run.status === "lost" ||
    run.status === "succeeded"
  );
}

function emptyCronState(): CronState {
  return {
    jobs: [],
    runs: [],
    updatedAt: nowIso(),
  };
}

function cloneCronState(state: CronState): CronState {
  return {
    jobs: [...state.jobs],
    runs: [...state.runs],
    updatedAt: state.updatedAt,
  };
}

function normalizeCronState(state: CronState): CronState {
  return {
    jobs: [...state.jobs],
    runs: [...state.runs]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, maxRetainedCronRuns),
    updatedAt: nowIso(),
  };
}

export class FileCronStore {
  constructor(private readonly projectRoot: string) {}

  private get cronRoot(): string {
    return path.join(resolveProjectStateRoot(this.projectRoot), "cron");
  }

  private get statePath(): string {
    return path.join(this.cronRoot, "state.json");
  }

  async ensureState(): Promise<CronState> {
    await ensureDir(this.cronRoot);
    const current = await this.readState();
    if (current) {
      return current;
    }
    const state = emptyCronState();
    await this.writeState(state);
    return state;
  }

  async readState(): Promise<CronState | null> {
    return readJson<CronState | null>(this.statePath, null);
  }

  async writeState(state: CronState): Promise<void> {
    await writeJson(this.statePath, normalizeCronState(state));
  }

  private async mutateState(
    updater: (state: CronState) => CronState | Promise<CronState>,
  ): Promise<CronState> {
    await ensureDir(this.cronRoot);
    return updateJson<CronState>(
      this.statePath,
      emptyCronState(),
      async (state) => normalizeCronState(await updater(cloneCronState(state))),
    );
  }

  async addJob(input: {
    deleteAfterRun?: boolean;
    deliveryMode?: "announce" | "none" | "webhook";
    maxAttempts?: number;
    name: string;
    prompt: string;
    provider?: ProviderName;
    schedule: CronSchedule;
    sessionTarget: CronSessionTarget;
    tags?: string[];
  }): Promise<CronJob> {
    const timestamp = nowIso();
    const job: CronJob = {
      createdAt: timestamp,
      deleteAfterRun: input.deleteAfterRun ?? input.schedule.kind === "at",
      deliveryMode: input.deliveryMode ?? "none",
      enabled: true,
      id: randomUUID(),
      maxAttempts: input.maxAttempts ?? 3,
      name: input.name,
      nextRunAt: nextRunAfter(input.schedule, new Date(timestamp)),
      prompt: input.prompt,
      ...(input.provider ? { provider: input.provider } : {}),
      schedule: input.schedule,
      sessionTarget: input.sessionTarget,
      tags: input.tags ?? [],
      updatedAt: timestamp,
    };
    await this.mutateState((state) => ({
      ...state,
      jobs: [...state.jobs, job],
    }));
    return job;
  }

  async listJobs(): Promise<CronJob[]> {
    return (await this.ensureState()).jobs.sort((left, right) =>
      left.nextRunAt.localeCompare(right.nextRunAt),
    );
  }

  async listRuns(jobId?: string): Promise<CronRunRecord[]> {
    const runs = (await this.ensureState()).runs;
    return runs.filter((run) => !jobId || run.jobId === jobId);
  }

  async removeJob(jobId: string): Promise<boolean> {
    let removed = false;
    await this.mutateState((state) => {
      const nextJobs = state.jobs.filter((job) => job.id !== jobId);
      removed = nextJobs.length !== state.jobs.length;
      return {
        ...state,
        jobs: nextJobs,
      };
    });
    return removed;
  }

  async forceDue(jobId: string, at = new Date()): Promise<CronJob | null> {
    let updated: CronJob | null = null;
    await this.mutateState((state) => {
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (!job) {
        return state;
      }
      updated = {
        ...job,
        enabled: true,
        nextRunAt: at.toISOString(),
        updatedAt: at.toISOString(),
      };
      return {
        ...state,
        jobs: state.jobs.map((candidate) =>
          candidate.id === jobId ? updated! : candidate,
        ),
      };
    });
    return updated;
  }

  async reconcileWithAgentState(state: AgentDaemonState): Promise<void> {
    await this.mutateState((cronState) => {
      let changed = false;
      const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
      const runs = cronState.runs.map((run) => {
        if (!run.taskId || isTerminalRun(run)) {
          return run;
        }
        const task = tasksById.get(run.taskId);
        if (!task) {
          changed = true;
          return {
            ...run,
            error: "task record disappeared",
            finishedAt: nowIso(),
            status: "lost" as const,
            updatedAt: nowIso(),
          };
        }
        if (task.status === "queued") {
          return run.status === "queued"
            ? run
            : { ...run, status: "queued" as const };
        }
        if (task.status === "running") {
          changed = true;
          return {
            ...run,
            startedAt: task.startedAt ?? run.startedAt,
            status: "running" as const,
            updatedAt: task.updatedAt,
          };
        }
        if (task.status === "completed") {
          changed = true;
          return {
            ...run,
            finishedAt: task.completedAt ?? task.updatedAt,
            status: "succeeded" as const,
            updatedAt: task.updatedAt,
          };
        }
        if (task.status === "lost") {
          changed = true;
          return {
            ...run,
            error: task.lastError,
            finishedAt: task.completedAt ?? task.updatedAt,
            status: "lost" as const,
            updatedAt: task.updatedAt,
          };
        }
        changed = true;
        return {
          ...run,
          error: task.lastError,
          finishedAt: task.completedAt ?? task.updatedAt,
          status: "failed" as const,
          updatedAt: task.updatedAt,
        };
      });

      const succeededOneShotJobIds = new Set(
        runs
          .filter((run) => run.status === "succeeded")
          .map((run) => run.jobId),
      );
      const jobs = cronState.jobs.filter(
        (job) =>
          !(
            job.schedule.kind === "at" &&
            job.deleteAfterRun &&
            succeededOneShotJobIds.has(job.id)
          ),
      );
      changed ||= jobs.length !== cronState.jobs.length;
      return changed ? { ...cronState, jobs, runs } : cronState;
    });
  }

  async enqueueDueJobs(
    state: AgentDaemonState,
    options: {
      maxConcurrentRuns?: number;
      now?: Date;
      projectKey: string;
      provider: ProviderName;
    },
  ): Promise<CronTickResult> {
    const now = options.now ?? new Date();
    const timestamp = now.toISOString();
    const maxConcurrentRuns = options.maxConcurrentRuns ?? 1;
    let nextState = state;
    const enqueued: CronRunRecord[] = [];
    const skipped: CronRunRecord[] = [];
    let jobsDue = 0;

    await this.mutateState((cronState) => {
      const activeRunCount = cronState.runs.filter(
        (run) => run.status === "queued" || run.status === "running",
      ).length;
      const dueJobs = cronState.jobs.filter(
        (job) => job.enabled && job.nextRunAt <= timestamp,
      );
      jobsDue = dueJobs.length;
      let concurrent = activeRunCount;
      const runs = [...cronState.runs];
      const jobs = cronState.jobs.map((job) => ({ ...job }));

      for (const job of dueJobs) {
        const jobIndex = jobs.findIndex((candidate) => candidate.id === job.id);
        if (jobIndex < 0) {
          continue;
        }
        const runId = randomUUID();
        const sessionKey = sessionKeyForRun(job, runId);
        if (concurrent >= maxConcurrentRuns) {
          const skippedRun: CronRunRecord = {
            attempt: 0,
            createdAt: timestamp,
            error: "max concurrent cron runs reached",
            finishedAt: timestamp,
            id: runId,
            jobId: job.id,
            projectKey: options.projectKey,
            provider: job.provider ?? options.provider,
            sessionKey,
            status: "skipped",
            updatedAt: timestamp,
          };
          skipped.push(skippedRun);
          runs.push(skippedRun);
        } else {
          const withTask = enqueueAgentTaskWithResult(
            nextState,
            {
              origin: {
                id: job.id,
                kind: "cron",
                runId,
                sessionTarget: job.sessionTarget,
              },
              priority: 10,
              prompt: job.prompt,
              provider: job.provider ?? options.provider,
              ...(job.sessionTarget.kind === "main" ? {} : { sessionKey }),
            },
            timestamp,
          );
          nextState = withTask.state;
          const run: CronRunRecord = {
            attempt: 1,
            createdAt: timestamp,
            id: runId,
            jobId: job.id,
            projectKey: options.projectKey,
            provider: job.provider ?? options.provider,
            sessionKey,
            status: "queued",
            taskId: withTask.task.id,
            updatedAt: timestamp,
          };
          enqueued.push(run);
          runs.push(run);
          concurrent += 1;
        }

        const updatedJob = jobs[jobIndex];
        if (updatedJob) {
          updatedJob.lastRunAt = timestamp;
          updatedJob.nextRunAt =
            updatedJob.schedule.kind === "interval"
              ? nextRunAfter(updatedJob.schedule, now)
              : updatedJob.nextRunAt;
          updatedJob.enabled = updatedJob.schedule.kind === "interval";
          updatedJob.updatedAt = timestamp;
        }
      }

      return dueJobs.length > 0
        ? {
            ...cronState,
            jobs,
            runs,
          }
        : cronState;
    });

    return {
      enqueued,
      jobsDue,
      skipped,
      state: nextState,
    };
  }
}

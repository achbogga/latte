import { randomUUID } from "node:crypto";
import path from "node:path";

import type { ContextPack, StressRun } from "@achbogga/latte-core";
import {
  createStressRun,
  defaultStressScenarios,
  readJson,
  writeJson,
} from "@achbogga/latte-core";

interface SessionEnvelope {
  createdAt: string;
  events: Array<{
    payload: Record<string, unknown>;
    timestamp: string;
    type: string;
  }>;
  id: string;
  projectKey: string;
  provider: string;
}

interface PersistedState {
  indexes: Record<string, ContextPack>;
  sessions: Record<string, SessionEnvelope>;
  stressRuns: Record<string, StressRun>;
}

export class ApiStore {
  constructor(
    private readonly dataPath = path.join(
      process.cwd(),
      "services",
      "api",
      ".data",
      "state.json",
    ),
  ) {}

  async getState(): Promise<PersistedState> {
    return readJson<PersistedState>(this.dataPath, {
      indexes: {},
      sessions: {},
      stressRuns: {},
    });
  }

  async saveIndex(contextPack: ContextPack): Promise<void> {
    const state = await this.getState();
    state.indexes[contextPack.projectKey] = contextPack;
    await writeJson(this.dataPath, state);
  }

  async getIndex(projectKey: string): Promise<ContextPack | null> {
    const state = await this.getState();
    return state.indexes[projectKey] ?? null;
  }

  async createSession(
    projectKey: string,
    provider: string,
  ): Promise<SessionEnvelope> {
    const state = await this.getState();
    const id = randomUUID();
    const session: SessionEnvelope = {
      createdAt: new Date().toISOString(),
      events: [],
      id,
      projectKey,
      provider,
    };
    state.sessions[id] = session;
    await writeJson(this.dataPath, state);
    return session;
  }

  async appendSessionEvent(
    id: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<SessionEnvelope | null> {
    const state = await this.getState();
    const session = state.sessions[id];
    if (!session) {
      return null;
    }
    session.events.push({
      payload,
      timestamp: new Date().toISOString(),
      type,
    });
    await writeJson(this.dataPath, state);
    return session;
  }

  async createStressRun(
    projectKey: string,
    scenarioId: string,
  ): Promise<StressRun> {
    const state = await this.getState();
    const scenario = defaultStressScenarios(projectKey).find(
      (candidate) => candidate.id === scenarioId,
    );
    if (!scenario) {
      throw new Error(`Unknown scenario ${scenarioId}`);
    }
    const run = createStressRun(scenario);
    state.stressRuns[run.id] = run;
    await writeJson(this.dataPath, state);
    return run;
  }

  async getStressRun(id: string): Promise<StressRun | null> {
    const state = await this.getState();
    return state.stressRuns[id] ?? null;
  }
}

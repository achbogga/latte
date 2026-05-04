import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { ensureDir, readJson, writeJson } from "./fs.js";
import type { ProviderName, SessionEvent, SessionRecord } from "./types.js";

interface AuthRecord {
  apiKey: string;
  savedAt: string;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createCacheKey(
  parts: Record<string, string | undefined>,
): string {
  const serialized = Object.keys(parts)
    .sort()
    .map((key) => `${key}=${parts[key] ?? ""}`)
    .join("|");
  return stableHash(serialized);
}

export function resolveProjectStateRoot(projectRoot: string): string {
  return path.join(projectRoot, ".latte");
}

export function resolveLatteHome(): string {
  return path.join(os.homedir(), ".config", "latte");
}

export class FileSessionStore {
  constructor(private readonly projectRoot: string) {}

  private get sessionsRoot(): string {
    return path.join(resolveProjectStateRoot(this.projectRoot), "sessions");
  }

  async create(
    projectKey: string,
    provider: ProviderName,
    cacheKey: string,
    options: { metadata?: Record<string, unknown>; sessionKey?: string } = {},
  ): Promise<SessionRecord> {
    await ensureDir(this.sessionsRoot);
    const session: SessionRecord = {
      cacheKey,
      createdAt: new Date().toISOString(),
      events: [],
      id: randomUUID(),
      metadata: options.metadata ?? {},
      projectKey,
      provider,
      ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.save(session);
    return session;
  }

  async getByKey(sessionKey: string): Promise<SessionRecord | null> {
    const sessions = await this.list();
    return (
      sessions.find((session) => session.sessionKey === sessionKey) ?? null
    );
  }

  async getOrCreateByKey(
    projectKey: string,
    provider: ProviderName,
    cacheKey: string,
    sessionKey: string,
    metadata: Record<string, unknown> = {},
  ): Promise<SessionRecord> {
    const existing = await this.getByKey(sessionKey);
    if (existing) {
      return existing;
    }
    return this.create(projectKey, provider, cacheKey, {
      metadata,
      sessionKey,
    });
  }

  async get(id: string): Promise<SessionRecord | null> {
    const filePath = path.join(this.sessionsRoot, `${id}.json`);
    return readJson<SessionRecord | null>(filePath, null);
  }

  async list(): Promise<SessionRecord[]> {
    await ensureDir(this.sessionsRoot);
    const indexPath = path.join(this.sessionsRoot, "index.json");
    return readJson<SessionRecord[]>(indexPath, []);
  }

  async save(session: SessionRecord): Promise<void> {
    const normalized: SessionRecord = {
      ...session,
      updatedAt: new Date().toISOString(),
    };
    const filePath = path.join(this.sessionsRoot, `${normalized.id}.json`);
    await writeJson(filePath, normalized);
    const sessions = (await this.list()).filter(
      (entry) => entry.id !== normalized.id,
    );
    sessions.push(normalized);
    await writeJson(path.join(this.sessionsRoot, "index.json"), sessions);
  }

  async appendEvent(id: string, event: SessionEvent): Promise<SessionRecord> {
    const session = await this.get(id);
    if (!session) {
      throw new Error(`Unknown session ${id}`);
    }
    session.events.push(event);
    await this.save(session);
    return session;
  }
}

export async function saveManagedAuth(apiKey: string): Promise<void> {
  const authPath = path.join(resolveLatteHome(), "auth.json");
  await writeJson(authPath, {
    apiKey,
    savedAt: new Date().toISOString(),
  } satisfies AuthRecord);
}

export async function readManagedAuth(): Promise<AuthRecord | null> {
  return readJson<AuthRecord | null>(
    path.join(resolveLatteHome(), "auth.json"),
    null,
  );
}

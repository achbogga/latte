import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createCacheKey,
  FileSessionStore,
} from "../packages/core/src/session.js";

describe("FileSessionStore", () => {
  test("creates and updates sessions", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "latte-session-"));
    const store = new FileSessionStore(projectRoot);
    const cacheKey = createCacheKey({ provider: "codex", repoSha: "abc" });
    const session = await store.create("demo", "codex", cacheKey);

    expect(session.cacheKey).toBe(cacheKey);
    await store.appendEvent(session.id, {
      payload: { ok: true },
      timestamp: new Date().toISOString(),
      type: "indexed",
    });
    const reloaded = await store.get(session.id);
    expect(reloaded?.events).toHaveLength(1);
  });
});

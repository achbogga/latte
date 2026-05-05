import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { readJson, updateJson, writeJson } from "../packages/core/src/fs.js";

describe("durable file state", () => {
  test("serializes concurrent json updates without losing writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "latte-fs-"));
    const filePath = path.join(root, "counter.json");

    await Promise.all(
      Array.from({ length: 32 }, async () =>
        updateJson(filePath, { count: 0 }, (current) => ({
          count: current.count + 1,
        })),
      ),
    );

    await expect(readJson(filePath, { count: 0 })).resolves.toEqual({
      count: 32,
    });
  });

  test("recovers from backup when primary json is corrupt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "latte-fs-"));
    const filePath = path.join(root, "state.json");

    await writeJson(filePath, { generation: 1 });
    await writeJson(filePath, { generation: 2 });
    await writeFile(filePath, "{corrupt", "utf8");

    await expect(readJson(filePath, { generation: 0 })).resolves.toEqual({
      generation: 1,
    });
  });

  test("reclaims stale lock directories after crashed writers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "latte-fs-"));
    const filePath = path.join(root, "state.json");
    const lockPath = `${filePath}.lock`;
    const old = new Date(Date.now() - 180_000);
    await mkdir(lockPath);
    await utimes(lockPath, old, old);

    await writeJson(filePath, { ok: true });

    await expect(readJson(filePath, { ok: false })).resolves.toEqual({
      ok: true,
    });
  });
});

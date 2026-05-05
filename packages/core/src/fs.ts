import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dirPath: string): Promise<void> {
  const handle = await open(dirPath, "r").catch(() => null);
  if (!handle) {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Some filesystems do not support directory fsync. Atomic rename still gives
    // readers a whole file; directory fsync is best-effort durability.
  } finally {
    await handle.close();
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return await readJsonFile<T>(filePath);
  } catch {
    try {
      return await readJsonFile<T>(`${filePath}.bak`);
    } catch {
      return fallback;
    }
  }
}

async function writeJsonUnlocked(
  filePath: string,
  value: unknown,
): Promise<void> {
  const dirPath = path.dirname(filePath);
  await ensureDir(dirPath);
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await syncFile(tempPath);
  await copyFile(filePath, `${filePath}.bak`).catch(() => undefined);
  await rename(tempPath, filePath);
  await syncDirectory(dirPath);
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: { staleMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  await ensureDir(path.dirname(filePath));
  const lockPath = `${filePath}.lock`;
  const staleMs = options.staleMs ?? 120_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath, { recursive: false });
      await writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            pid: process.pid,
          },
          null,
          2,
        ),
        "utf8",
      ).catch(() => undefined);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > staleMs) {
        await rm(lockPath, { force: true, recursive: true });
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out acquiring lock ${lockPath}`);
      }
      await sleep(25 + Math.floor(Math.random() * 50));
      continue;
    }

    try {
      return await fn();
    } finally {
      await rm(lockPath, { force: true, recursive: true });
    }
  }
}

export async function writeJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await withFileLock(filePath, () => writeJsonUnlocked(filePath, value));
}

export async function updateJson<T>(
  filePath: string,
  fallback: T,
  updater: (current: T) => T | Promise<T>,
): Promise<T> {
  return withFileLock(filePath, async () => {
    const current = await readJson<T>(filePath, fallback);
    const next = await updater(current);
    await writeJsonUnlocked(filePath, next);
    return next;
  });
}

async function writeTextUnlocked(
  filePath: string,
  value: string,
): Promise<void> {
  const dirPath = path.dirname(filePath);
  await ensureDir(dirPath);
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(tempPath, value, "utf8");
  await syncFile(tempPath);
  await copyFile(filePath, `${filePath}.bak`).catch(() => undefined);
  await rename(tempPath, filePath);
  await syncDirectory(dirPath);
}

export async function writeText(
  filePath: string,
  value: string,
): Promise<void> {
  await withFileLock(filePath, () => writeTextUnlocked(filePath, value));
}

import { randomUUID } from "node:crypto";
import path from "node:path";

import { readJson, writeJson } from "./fs.js";
import type { MemoryItem, RetrievalHit } from "./types.js";

function lexicalScore(query: string, content: string): number {
  const queryTokens = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
  const contentTokens = content.toLowerCase().split(/\W+/).filter(Boolean);
  let matches = 0;
  for (const token of contentTokens) {
    if (queryTokens.has(token)) {
      matches += 1;
    }
  }
  return matches / Math.max(queryTokens.size, 1);
}

export class JsonMemoryStore {
  constructor(private readonly stateRoot: string) {}

  private get filePath(): string {
    return path.join(this.stateRoot, "memory.json");
  }

  async add(item: Omit<MemoryItem, "createdAt" | "id">): Promise<MemoryItem> {
    const current = await this.list(item.namespace);
    const record: MemoryItem = {
      ...item,
      createdAt: new Date().toISOString(),
      id: randomUUID(),
    };
    current.push(record);
    await writeJson(this.filePath, current);
    return record;
  }

  async list(namespace: string): Promise<MemoryItem[]> {
    const all = await readJson<MemoryItem[]>(this.filePath, []);
    return all.filter((item) => item.namespace === namespace);
  }

  async search(namespace: string, query: string): Promise<MemoryItem[]> {
    const all = await this.list(namespace);
    return all
      .map((item) => ({
        item,
        score: lexicalScore(query, item.content),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.item);
  }
}

export function rerankHits(
  query: string,
  hits: RetrievalHit[],
): RetrievalHit[] {
  return [...hits].sort((left, right) => {
    const leftScore = left.score + lexicalScore(query, left.excerpt);
    const rightScore = right.score + lexicalScore(query, right.excerpt);
    return rightScore - leftScore;
  });
}

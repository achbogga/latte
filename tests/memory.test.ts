import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { JsonMemoryStore, rerankHits } from "../packages/core/src/memory.js";

describe("memory and reranking", () => {
  test("stores and retrieves lexical memories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "latte-memory-"));
    const store = new JsonMemoryStore(root);
    await store.add({
      confidence: 0.9,
      content: "Boba prefers advisory mode before automation.",
      kind: "policy",
      metadata: {},
      namespace: "boba",
      provenance: ["test"],
    });
    await store.add({
      confidence: 0.8,
      content: "TSQBEV runs long-horizon research loops with durable memory.",
      kind: "fact",
      metadata: {},
      namespace: "boba",
      provenance: ["test"],
    });

    const results = await store.search("boba", "advisory automation");
    expect(results[0]?.content).toContain("advisory mode");

    const reranked = rerankHits("research loops", [
      {
        excerpt: "short note",
        id: "a",
        metadata: {},
        path: "a.md",
        score: 0.9,
      },
      {
        excerpt: "research loops and durable memory",
        id: "b",
        metadata: {},
        path: "b.md",
        score: 0.3,
      },
    ]);
    expect(reranked[0]?.id).toBe("b");
  });
});

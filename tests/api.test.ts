import { describe, expect, test } from "vitest";

import { buildApp } from "../services/api/src/app.js";

describe("api", () => {
  test("indexes a project and returns a brief", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      payload: {
        artifacts: [],
        generatedAt: new Date().toISOString(),
        projectKey: "boba",
        repo: { branch: "main", root: "/tmp/boba", sha: "abc" },
        rules: ["AGENTS.md"],
        summary: ["repo: boba"],
      },
      url: "/v1/index",
    });

    const response = await app.inject({
      method: "POST",
      payload: { projectKey: "boba" },
      url: "/v1/briefs",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ summary: string[] }>();
    expect(body.summary).toContain("repo: boba");
  });
});

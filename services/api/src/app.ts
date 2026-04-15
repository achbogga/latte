import Fastify from "fastify";
import { z } from "zod";

import { ApiStore } from "./store.js";

export function buildApp(store = new ApiStore()) {
  const app = Fastify({ logger: false });

  app.get("/health", () => ({ status: "ok" }));

  app.post("/v1/index", async (request, reply) => {
    const bodySchema = z.object({
      artifacts: z.array(
        z.object({
          content: z.string(),
          contentHash: z.string(),
          path: z.string(),
          size: z.number(),
        }),
      ),
      generatedAt: z.string(),
      projectKey: z.string(),
      repo: z.object({
        branch: z.string().nullable(),
        root: z.string(),
        sha: z.string().nullable(),
      }),
      rules: z.array(z.string()),
      summary: z.array(z.string()),
    });
    const payload = bodySchema.parse(request.body);
    await store.saveIndex(payload);
    reply.code(202);
    return { accepted: true, projectKey: payload.projectKey };
  });

  app.post("/v1/briefs", async (request) => {
    const bodySchema = z.object({ projectKey: z.string() });
    const { projectKey } = bodySchema.parse(request.body);
    const contextPack = await store.getIndex(projectKey);
    if (!contextPack) {
      return { projectKey, summary: ["No index available yet."] };
    }
    return {
      projectKey,
      rules: contextPack.rules,
      summary: contextPack.summary,
    };
  });

  app.post("/v1/sessions", async (request) => {
    const bodySchema = z.object({
      projectKey: z.string(),
      provider: z.string(),
    });
    const { projectKey, provider } = bodySchema.parse(request.body);
    return store.createSession(projectKey, provider);
  });

  app.post("/v1/sessions/:id/events", async (request, reply) => {
    const bodySchema = z.object({
      payload: z.record(z.string(), z.unknown()),
      type: z.string(),
    });
    const paramsSchema = z.object({ id: z.string() });
    const { id } = paramsSchema.parse(request.params);
    const { payload, type } = bodySchema.parse(request.body);
    const session = await store.appendSessionEvent(id, type, payload);
    if (!session) {
      reply.code(404);
      return { error: "session_not_found" };
    }
    return session;
  });

  app.post("/v1/agent/runs", async (request) => {
    const bodySchema = z.object({
      projectKey: z.string(),
      provider: z.string(),
      prompt: z.string(),
      sessionId: z.string().optional(),
    });
    const { projectKey, provider, prompt, sessionId } = bodySchema.parse(
      request.body,
    );
    const brief = await store.getIndex(projectKey);
    return {
      mode: sessionId ? "resume" : "fresh",
      prompt,
      provider,
      sessionId,
      summary: brief?.summary ?? ["No durable brief stored yet."],
    };
  });

  app.post("/v1/stress/runs", async (request) => {
    const bodySchema = z.object({
      projectKey: z.string(),
      scenarioId: z.string(),
    });
    const { projectKey, scenarioId } = bodySchema.parse(request.body);
    return store.createStressRun(projectKey, scenarioId);
  });

  app.get("/v1/stress/runs/:id", async (request, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const { id } = paramsSchema.parse(request.params);
    const run = await store.getStressRun(id);
    if (!run) {
      reply.code(404);
      return { error: "stress_run_not_found" };
    }
    return run;
  });

  return app;
}

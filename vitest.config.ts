import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@achbogga/latte-core": path.resolve(
        __dirname,
        "packages/core/src/index.ts",
      ),
      "@achbogga/latte-provider-claude": path.resolve(
        __dirname,
        "packages/provider-claude/src/index.ts",
      ),
      "@achbogga/latte-provider-codex": path.resolve(
        __dirname,
        "packages/provider-codex/src/index.ts",
      ),
    },
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});

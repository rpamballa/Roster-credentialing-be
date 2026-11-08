import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    environment: "node",
    // These tests touch a real Postgres (per `apps/api/test/setup.ts`).
    // Run serially to avoid cross-test TRUNCATE races on the shared DB.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});

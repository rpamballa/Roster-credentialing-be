import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    environment: "node",
    // Serial so concurrent TRUNCATE doesn't race the shared Postgres
    // instance — same convention as @cred/db / @cred/signal-eval.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});

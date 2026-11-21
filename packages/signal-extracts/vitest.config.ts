import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests hit real Postgres via @cred/db's shared schema + truncate
    // helpers in ./test/setup.ts. Serial execution mirrors @cred/db's
    // and @cred/signal-ingest's config.
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});

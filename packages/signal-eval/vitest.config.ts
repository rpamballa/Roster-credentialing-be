import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests hit real Postgres through @cred/db's schema + truncate
    // helpers in ./test/setup.ts. Serial execution mirrors @cred/db
    // and @cred/signal-ingest so concurrent TRUNCATEs don't race on
    // the shared DB.
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});

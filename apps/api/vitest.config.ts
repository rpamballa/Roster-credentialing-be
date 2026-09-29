import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // Global mocks for outbound delivery boundaries — every test file
    // inherits sendEmail/sendSms/notifySupportTicket capture buffers
    // so route tests can assert what was actually attempted, not just
    // what the audit row claims.
    setupFiles: ["./test/setupMocks.ts"],
  },
});

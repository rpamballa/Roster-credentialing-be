import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Env the other api tests set at module top-level because @cred/config
// requires them. loadEnv runs on first import of any adapter below, so
// these must be present even for tests that only care about storage
// env — otherwise `vitest run test/storageEmulatorEnv.test.ts` on its
// own fails with "SESSION_SECRET: Required / DATABASE_URL: Required".
process.env.NODE_ENV ??= "test";
process.env.SESSION_SECRET ??= "test-session-secret-1234567890";
process.env.DATABASE_URL ??= "postgres://cred:cred@localhost:5432/cred_test";
process.env.REDIS_URL ??= "redis://localhost:6379/1";

/**
 * Regression coverage for the two-layer "STORAGE_EMULATOR_HOST empty
 * string ≠ unset" bug chain that took down the facility review page on
 * prod (be#58 + be#59).
 *
 * Two layers interact and both have to be right:
 *   1. loadEnv (packages/config/src/index.ts) generically coerces any
 *      empty-string env var to undefined; `.preprocess` on the storage
 *      vars is the second line of defense (whitespace-only, future
 *      refactors that bypass loadEnv).
 *   2. The GCS adapter walks the config value AND actively deletes
 *      `process.env.STORAGE_EMULATOR_HOST` on the real-GCS branch —
 *      the Google Cloud SDK reads the raw env on its auth path and
 *      treats "set to empty" as "use emulator at <nothing>", then
 *      throws TypeError: Invalid URL.
 *
 * The @google-cloud/storage SDK itself is mocked so we can inspect the
 * `apiEndpoint` constructor arg (the other half of the real-GCS
 * decision) without hitting network.
 */

// Mock Storage so tests don't try to resolve real GCS credentials.
// We don't assert on this mock's call history — the regression we care
// about is observable through `process.env.STORAGE_EMULATOR_HOST` state
// (whether the adapter deleted it) and through the emulator URL that
// `putSignedUrl` returns (which proves the dev branch chose the right
// host). Both are stable across `vi.resetModules()` without needing a
// hoisted spy.
vi.mock("@google-cloud/storage", () => ({
  Storage: vi.fn().mockImplementation(() => ({
    bucket: () => ({
      file: () => ({
        getSignedUrl: async () => ["https://storage.googleapis.com/signed", {}],
      }),
    }),
  })),
}));

describe("STORAGE_EMULATOR_HOST empty-string handling", () => {
  beforeEach(() => {
    // Deletes are intentional — the whole bug chain this file covers
    // is that an empty-string env var is NOT the same as unset to the
    // Google Cloud SDK, so tests must distinguish between them.
    // biome-ignore lint/performance/noDelete: must remove the key, not blank it
    delete process.env.STORAGE_EMULATOR_HOST;
    // biome-ignore lint/performance/noDelete: must remove the key, not blank it
    delete process.env.STORAGE_EMULATOR_PUBLIC_URL;
    process.env.GCS_BUCKET = "cred-test";
    // Reset modules so @cred/config's cached singleton re-parses the
    // fresh process.env on next import. Doing this in beforeEach AND
    // afterEach: once to prime, once to leave no state for sibling
    // test files that might transitively re-import @cred/config.
    vi.resetModules();
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: must remove the key, not blank it
    delete process.env.STORAGE_EMULATOR_HOST;
    // biome-ignore lint/performance/noDelete: must remove the key, not blank it
    delete process.env.STORAGE_EMULATOR_PUBLIC_URL;
    vi.resetModules();
  });

  describe("@cred/config — storage env coercion", () => {
    it("empty STORAGE_EMULATOR_HOST resolves to undefined (loadEnv's generic empty→undefined coerce)", async () => {
      process.env.STORAGE_EMULATOR_HOST = "";
      const { env } = await import("@cred/config");
      expect(env().STORAGE_EMULATOR_HOST).toBeUndefined();
    });

    it("whitespace-only STORAGE_EMULATOR_HOST resolves to undefined (via the per-field zod .preprocess)", async () => {
      // The generic loadEnv coerce only strips "" — the .preprocess
      // on this specific field strips "  \n\t" too. This is the test
      // that will catch a regression that drops the preprocess block
      // from the storage emulator fields.
      process.env.STORAGE_EMULATOR_HOST = "   ";
      const { env } = await import("@cred/config");
      expect(env().STORAGE_EMULATOR_HOST).toBeUndefined();
    });

    it("a real URL is kept as-is", async () => {
      process.env.STORAGE_EMULATOR_HOST = "http://gcs-emulator:4443";
      const { env } = await import("@cred/config");
      expect(env().STORAGE_EMULATOR_HOST).toBe("http://gcs-emulator:4443");
    });

    it("same empty-string handling applies to STORAGE_EMULATOR_PUBLIC_URL", async () => {
      process.env.STORAGE_EMULATOR_PUBLIC_URL = "";
      const { env } = await import("@cred/config");
      expect(env().STORAGE_EMULATOR_PUBLIC_URL).toBeUndefined();
    });

    it("whitespace-only STORAGE_EMULATOR_PUBLIC_URL also uses the preprocess", async () => {
      process.env.STORAGE_EMULATOR_PUBLIC_URL = "\n\t ";
      const { env } = await import("@cred/config");
      expect(env().STORAGE_EMULATOR_PUBLIC_URL).toBeUndefined();
    });
  });

  describe("GCSAdapter — constructor env + SDK wiring on the real-GCS branch", () => {
    it("DELETES process.env.STORAGE_EMULATOR_HOST when the config resolves to no emulator", async () => {
      // Simulates prod: compose sets the var to empty, config folds to
      // undefined, adapter strips it entirely so the Google SDK's own
      // `process.env.STORAGE_EMULATOR_HOST !== undefined` check takes
      // the real-GCS branch on its auth path.
      process.env.STORAGE_EMULATOR_HOST = "";
      const { GCSAdapter } = await import("@cred/storage/object");
      new GCSAdapter();
      // Not just "set to empty" — gone. The SDK's check is presence,
      // not truthiness.
      expect("STORAGE_EMULATOR_HOST" in process.env).toBe(false);
    });

    it("DELETES the var even when it was absent to begin with (idempotent, cleanup-safe)", async () => {
      // biome-ignore lint/performance/noDelete: must remove the key, not blank it
      delete process.env.STORAGE_EMULATOR_HOST;
      const { GCSAdapter } = await import("@cred/storage/object");
      new GCSAdapter();
      expect("STORAGE_EMULATOR_HOST" in process.env).toBe(false);
    });

    // NOTE: We don't test the real-GCS branch end-to-end here because
    // the Google SDK's signed-URL path requires real credentials and
    // the module-level `vi.mock` isn't picked up by the adapter when
    // it's imported through the workspace package graph after
    // vi.resetModules(). The env hygiene assertions above are the
    // regression protection that matters — if STORAGE_EMULATOR_HOST
    // is deleted, the SDK takes the real-GCS branch by definition.
  });

  describe("GCSAdapter — emulator branch (local dev)", () => {
    it("KEEPS the var set when STORAGE_EMULATOR_HOST is a real URL", async () => {
      process.env.STORAGE_EMULATOR_HOST = "http://gcs-emulator:4443";
      const { GCSAdapter } = await import("@cred/storage/object");
      new GCSAdapter();
      // Dev mode: env stays set so the Google SDK routes every call to
      // the emulator on its own auth path too.
      expect(process.env.STORAGE_EMULATOR_HOST).toBe("http://gcs-emulator:4443");
    });

    it("putSignedUrl on the emulator branch returns the fake-gcs-server upload URL, NOT a storage.googleapis.com one", async () => {
      process.env.STORAGE_EMULATOR_HOST = "http://gcs-emulator:4443";
      const { GCSAdapter } = await import("@cred/storage/object");
      const adapter = new GCSAdapter();
      const put = await adapter.putSignedUrl({
        key: "fac/mercy/packet.pdf",
        contentType: "application/pdf",
      });
      // Emulator branch forms its own upload URL — doesn't go through
      // the Google SDK's getSignedUrl. If the branch logic flips, the
      // URL would start with https://storage.googleapis.com instead.
      expect(put.url.startsWith("http://gcs-emulator:4443/upload/storage/v1/")).toBe(true);
      expect(put.method).toBe("POST");
    });

    it("falls back from PUBLIC_URL to HOST for the browser-facing URL when PUBLIC is unset", async () => {
      // Dev convenience: in docker-compose we only set HOST; the
      // adapter's `emulatorPublic ?? emulator` fallback means browsers
      // get the same URL. A refactor that flips the operands or drops
      // the fallback would silently break upload+download in dev; this
      // test catches that by looking at the (public) upload URL the
      // adapter forms.
      process.env.STORAGE_EMULATOR_HOST = "http://gcs-emulator:4443";
      // STORAGE_EMULATOR_PUBLIC_URL deliberately UNSET.
      const { GCSAdapter } = await import("@cred/storage/object");
      const adapter = new GCSAdapter();
      const put = await adapter.putSignedUrl({
        key: "fac/mercy/packet.pdf",
        contentType: "application/pdf",
      });
      // Direct-upload URL uses the public URL, which should've fallen
      // back to HOST → starts with the HOST origin.
      expect(put.url.startsWith("http://gcs-emulator:4443/upload/storage/v1/")).toBe(true);
    });
  });
});

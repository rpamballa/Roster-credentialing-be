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
 * The @google-cloud/storage SDK is mocked so tests don't try to resolve
 * real GCS credentials; we don't assert on the mock, we assert on the
 * observable effects (process.env state, putSignedUrl output).
 */

vi.mock("@google-cloud/storage", () => ({
  Storage: vi.fn().mockImplementation(() => ({
    bucket: () => ({
      file: () => ({
        getSignedUrl: async () => ["https://storage.googleapis.com/signed", {}],
      }),
    }),
  })),
}));

// Snapshot the keys this file touches so afterEach can restore them
// exactly as the worker had them. Sibling test files (packet.test.ts,
// webhooks.test.ts, etc.) all share the same vitest worker process and
// read these vars at module eval time — if we leak our synthetic values
// their assertions break (seen on the first CI run of this PR).
const TOUCHED_KEYS = [
  "STORAGE_EMULATOR_HOST",
  "STORAGE_EMULATOR_PUBLIC_URL",
  "GCS_BUCKET",
] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const k of TOUCHED_KEYS) {
  originalEnv[k] = process.env[k];
}

function restoreEnv() {
  for (const k of TOUCHED_KEYS) {
    const original = originalEnv[k];
    if (original === undefined) {
      // biome-ignore lint/performance/noDelete: must remove the key, not blank it
      delete process.env[k];
    } else {
      process.env[k] = original;
    }
  }
}

describe("STORAGE_EMULATOR_HOST empty-string handling", () => {
  beforeEach(() => {
    // Start every test from the same baseline: nothing emulator-ish
    // set, GCS_BUCKET pinned to a test-specific value.
    // biome-ignore lint/performance/noDelete: must remove the key, not blank it
    delete process.env.STORAGE_EMULATOR_HOST;
    // biome-ignore lint/performance/noDelete: must remove the key, not blank it
    delete process.env.STORAGE_EMULATOR_PUBLIC_URL;
    process.env.GCS_BUCKET = "cred-test";
    vi.resetModules();
  });

  afterEach(() => {
    // Fully restore the worker's env + rebuild the module graph so
    // sibling files load a fresh @cred/config against the real env.
    restoreEnv();
    vi.resetModules();
  });

  describe("@cred/config — storage env coercion", () => {
    it("empty STORAGE_EMULATOR_HOST resolves to undefined (loadEnv's generic empty→undefined coerce)", async () => {
      process.env.STORAGE_EMULATOR_HOST = "";
      const { env } = await import("@cred/config");
      expect(env().STORAGE_EMULATOR_HOST).toBeUndefined();
    });

    it("whitespace-only STORAGE_EMULATOR_HOST resolves to undefined (via the per-field zod .preprocess)", async () => {
      // loadEnv's generic coerce only strips exact "" — the .preprocess
      // on this specific field strips "  \n\t" too. This is the test
      // that catches a regression that drops the preprocess block.
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

  describe("GCSAdapter — constructor env hygiene on the real-GCS branch", () => {
    it("DELETES process.env.STORAGE_EMULATOR_HOST when the config resolves to no emulator", async () => {
      process.env.STORAGE_EMULATOR_HOST = "";
      const { GCSAdapter } = await import("@cred/storage/object");
      new GCSAdapter();
      // Not just "set to empty" — gone. The Google SDK's own check is
      // `env.STORAGE_EMULATOR_HOST !== undefined`, not truthiness.
      expect("STORAGE_EMULATOR_HOST" in process.env).toBe(false);
    });

    it("DELETES the var even when it was absent to begin with (idempotent, cleanup-safe)", async () => {
      // beforeEach already removes it; adapter should still produce
      // the absent state (not throw on the delete-of-missing).
      const { GCSAdapter } = await import("@cred/storage/object");
      new GCSAdapter();
      expect("STORAGE_EMULATOR_HOST" in process.env).toBe(false);
    });

    // NOTE: We don't test the real-GCS branch end-to-end because the
    // Google SDK's signed-URL path requires real credentials and the
    // module-level vi.mock isn't picked up by the adapter after
    // vi.resetModules() + workspace package resolution. The env
    // hygiene assertions above are the regression protection — if
    // STORAGE_EMULATOR_HOST is deleted, the SDK takes the real-GCS
    // branch by definition.
  });

  describe("GCSAdapter — emulator branch (local dev)", () => {
    it("KEEPS the var set when STORAGE_EMULATOR_HOST is a real URL", async () => {
      process.env.STORAGE_EMULATOR_HOST = "http://gcs-emulator:4443";
      const { GCSAdapter } = await import("@cred/storage/object");
      new GCSAdapter();
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
      // Emulator branch forms its own upload URL and never calls the
      // Google SDK's getSignedUrl. If the branch logic flips, the URL
      // would start with https://storage.googleapis.com instead.
      expect(put.url.startsWith("http://gcs-emulator:4443/upload/storage/v1/")).toBe(true);
      expect(put.method).toBe("POST");
    });

    it("falls back from PUBLIC_URL to HOST for the browser-facing URL when PUBLIC is unset", async () => {
      // Dev convenience: docker-compose only sets HOST; the adapter's
      // `emulatorPublic ?? emulator` fallback means browsers get the
      // same URL. A refactor that flips the operands or drops the
      // fallback would silently break upload+download in dev.
      process.env.STORAGE_EMULATOR_HOST = "http://gcs-emulator:4443";
      // STORAGE_EMULATOR_PUBLIC_URL deliberately UNSET (beforeEach).
      const { GCSAdapter } = await import("@cred/storage/object");
      const adapter = new GCSAdapter();
      const put = await adapter.putSignedUrl({
        key: "fac/mercy/packet.pdf",
        contentType: "application/pdf",
      });
      expect(put.url.startsWith("http://gcs-emulator:4443/upload/storage/v1/")).toBe(true);
    });
  });
});

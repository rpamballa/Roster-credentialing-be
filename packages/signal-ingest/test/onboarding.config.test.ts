// Agency-onboarding config tests.
//
// Scope: pure functions in src/onboarding/*. The bootstrap runner in
// scripts/signal-onboard.ts is covered by hand on staging — these
// tests cover the schema (what a valid config looks like, what shape
// the runner expects) and the credential-source resolver (where the
// adapter payload comes from before encryption).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgencyConfigError,
  CredentialResolutionError,
  parseAgencyConfig,
  resolveCredentials,
} from "../src/onboarding/index.js";

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    agency: { slug: "example-locum", name: "Example", type: "agency", signalEnabled: true },
    specialists: [],
    config: [],
    knowledge: [],
    adapters: {},
    gaps: [],
    ...overrides,
  };
}

describe("parseAgencyConfig", () => {
  it("accepts a minimal valid config", () => {
    const cfg = parseAgencyConfig(validConfig());
    expect(cfg.agency.slug).toBe("example-locum");
    expect(cfg.specialists).toEqual([]);
  });

  it("rejects an unknown schemaVersion", () => {
    expect(() => parseAgencyConfig(validConfig({ schemaVersion: 2 }))).toThrow(AgencyConfigError);
  });

  it("rejects an invalid slug", () => {
    expect(() =>
      parseAgencyConfig(validConfig({ agency: { slug: "Not Valid!", name: "x" } })),
    ).toThrow(AgencyConfigError);
  });

  it("defaults runOnBootstrap to preview-only", () => {
    const cfg = parseAgencyConfig(
      validConfig({
        adapters: {
          bullhorn: {
            enabled: true,
            credentials: { source: "inline", values: { token: "t" } },
          },
        },
      }),
    );
    expect(cfg.adapters.bullhorn?.runOnBootstrap).toEqual({ preview: true, sync: false });
  });

  it("refuses an enabled adapter with no credentials", () => {
    expect(() =>
      parseAgencyConfig(
        validConfig({
          adapters: { bullhorn: { enabled: true } },
        }),
      ),
    ).toThrow(/enabled but has no credentials/);
  });

  it("refuses a disabled adapter that still carries credentials", () => {
    expect(() =>
      parseAgencyConfig(
        validConfig({
          adapters: {
            bullhorn: {
              enabled: false,
              credentials: { source: "inline", values: { token: "t" } },
            },
          },
        }),
      ),
    ).toThrow(/disabled but still carries credentials/);
  });

  it("surfaces zod issues on a malformed specialist", () => {
    try {
      parseAgencyConfig(
        validConfig({
          specialists: [{ email: "not-an-email", name: "x" }],
        }),
      );
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgencyConfigError);
      expect((err as AgencyConfigError).issues.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveCredentials", () => {
  const SAVED_ENV = process.env;
  beforeEach(() => {
    process.env = { ...SAVED_ENV };
  });
  afterEach(() => {
    process.env = SAVED_ENV;
  });

  it("reads env credentials", () => {
    process.env.TEST_CLIENT_ID = "abc";
    process.env.TEST_CLIENT_SECRET = "def";
    const out = resolveCredentials("bullhorn", {
      source: "env",
      map: { clientId: "TEST_CLIENT_ID", clientSecret: "TEST_CLIENT_SECRET" },
    });
    expect(out).toEqual({ clientId: "abc", clientSecret: "def" });
  });

  it("names every missing env var in one error", () => {
    // Setting to "" is treated as missing by resolveEnv — same effect
    // as `delete`, and biome bans `delete` under performance/noDelete.
    process.env.MISSING_A = "";
    process.env.MISSING_B = "";
    try {
      resolveCredentials("bullhorn", {
        source: "env",
        map: { a: "MISSING_A", b: "MISSING_B" },
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialResolutionError);
      expect((err as Error).message).toContain("MISSING_A");
      expect((err as Error).message).toContain("MISSING_B");
    }
  });

  it("returns inline values by default", () => {
    process.env.NODE_ENV = "development";
    const out = resolveCredentials("gmail", {
      source: "inline",
      values: { token: "inline-token" },
    });
    expect(out).toEqual({ token: "inline-token" });
  });

  it("refuses inline credentials in production unless opted in", () => {
    process.env.NODE_ENV = "production";
    expect(() => resolveCredentials("gmail", { source: "inline", values: { token: "t" } })).toThrow(
      /inline credentials refused/,
    );
    const ok = resolveCredentials(
      "gmail",
      { source: "inline", values: { token: "t" } },
      { allowInlineInProd: true },
    );
    expect(ok).toEqual({ token: "t" });
  });

  it("reads file credentials from a JSON object", () => {
    const dir = mkdtempSync(join(tmpdir(), "signal-onboard-"));
    const path = join(dir, "creds.json");
    writeFileSync(path, JSON.stringify({ clientId: "from-file", clientSecret: "shh" }));
    try {
      const out = resolveCredentials("bullhorn", { source: "file", path });
      expect(out).toEqual({ clientId: "from-file", clientSecret: "shh" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a file whose root is not a JSON object", () => {
    const dir = mkdtempSync(join(tmpdir(), "signal-onboard-"));
    const path = join(dir, "arr.json");
    writeFileSync(path, JSON.stringify(["not", "an", "object"]));
    try {
      expect(() => resolveCredentials("bullhorn", { source: "file", path })).toThrow(/JSON object/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a file with non-string values", () => {
    const dir = mkdtempSync(join(tmpdir(), "signal-onboard-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ clientId: "ok", port: 443 }));
    try {
      expect(() => resolveCredentials("bullhorn", { source: "file", path })).toThrow(
        /must be a string/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

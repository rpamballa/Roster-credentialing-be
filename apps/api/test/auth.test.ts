import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Set env BEFORE importing app code so @cred/config picks it up.
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-session-secret-1234567890";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cred:cred@localhost:5432/cred_test";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";
process.env.API_PUBLIC_URL = "http://localhost:3001";
process.env.WEB_PUBLIC_URL = "http://localhost:3000";

const { ensureSchema, truncateAll } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL);

const { buildApp } = await import("../src/app.js");
const { hashToken } = await import("@cred/auth");
const { db, schema } = await import("@cred/db");
const { eq } = await import("drizzle-orm");
const { closeDb } = await import("@cred/db");
const { closeSessionStore } = await import("@cred/auth");

const app = buildApp();

async function call(method: string, path: string, body?: unknown, headers: HeadersInit = {}) {
  const init: RequestInit = { method, headers: { "content-type": "application/json", ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.fetch(new Request(`http://localhost${path}`, init));
}

describe("api smoke", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });

  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });

  afterAll(async () => {
    await closeDb();
    await closeSessionStore();
  });

  it("GET /health returns ok", async () => {
    const res = await call("GET", "/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("magic-link request + verify produces a session, then /me works", async () => {
    const reqRes = await call("POST", "/auth/magic-link/request", {
      email: "user@example.com",
    });
    expect(reqRes.status).toBe(200);

    // Find the issued token row directly — in dev/test, no email is sent.
    const rows = await db()
      .select()
      .from(schema.magicLinkTokens)
      .where(eq(schema.magicLinkTokens.email, "user@example.com"));
    expect(rows.length).toBe(1);

    // We can't read the plaintext token back (we only stored the hash). So
    // forge a valid token + hash here, insert it, and verify it.
    const token = "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const hash = hashToken(token);
    await db()
      .update(schema.magicLinkTokens)
      .set({ tokenHash: hash })
      .where(eq(schema.magicLinkTokens.email, "user@example.com"));

    const verifyRes = await call("POST", "/auth/magic-link/verify", { token });
    expect(verifyRes.status).toBe(200);
    const setCookie = verifyRes.headers.get("set-cookie") ?? "";
    expect(setCookie).toBeTruthy();
    const sid = setCookie.split(";")[0]?.split("=")[1] ?? "";
    expect(sid).not.toBe("");

    const meRes = await call("GET", "/me", undefined, {
      cookie: `cred_sid=${sid}`,
    });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { email: string; memberships: unknown[] };
    expect(me.email).toBe("user@example.com");
    expect(me.memberships).toEqual([]);
  });

  it("/me without a session is 401", async () => {
    const res = await call("GET", "/me");
    expect(res.status).toBe(401);
  });

  it("a consumed token cannot be reused", async () => {
    const token = "single-use-token-bbbbbbbbbbbbbbbbbbbbbbbb";
    const hash = hashToken(token);
    await db()
      .insert(schema.magicLinkTokens)
      .values({
        tokenHash: hash,
        email: "single@example.com",
        expiresAt: new Date(Date.now() + 60_000),
      });

    const first = await call("POST", "/auth/magic-link/verify", { token });
    expect(first.status).toBe(200);

    const second = await call("POST", "/auth/magic-link/verify", { token });
    expect(second.status).toBe(400);
  });
});

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

  // The magic-link request + verify tests were removed in 2026-11. The
  // flow stranded users by upserting users rows without providers rows
  // (shanthanramidi@gmail.com was the canonical case). /auth/magic-link/*
  // no longer exists; the endpoints 404 and the magic_link_tokens table
  // was dropped in migration 0020. Password auth is the only user-facing
  // credential flow now.

  it("/auth/magic-link/request is gone — returns 404", async () => {
    const res = await call("POST", "/auth/magic-link/request", { email: "user@example.com" });
    expect(res.status).toBe(404);
  });

  it("/auth/magic-link/verify is gone — returns 404", async () => {
    const res = await call("POST", "/auth/magic-link/verify", { token: "x".repeat(40) });
    expect(res.status).toBe(404);
  });

  it("/me without a session is 401", async () => {
    const res = await call("GET", "/me");
    expect(res.status).toBe(401);
  });
});

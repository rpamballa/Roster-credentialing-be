import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
const { createSession, closeSessionStore } = await import("@cred/auth");
const { db, schema, closeDb } = await import("@cred/db");
const { eq } = await import("drizzle-orm");

const app = buildApp();

/**
 * Grab-bag of endpoints that had no coverage:
 *   - /health/ready (readiness probe)
 *   - /v1/marketing/leads (public lead intake)
 *   - /v1/support/report (staff-gated)
 *   - /cockpit/metrics/baseline (staff-gated)
 *   - /v1/workspace/me (staff-gated)
 */
describe("public + workspace misc endpoints", () => {
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

  // Rate limiters are keyed on the caller IP and back-off through Redis
  // (which persists across tests in this suite). Use a per-call unique
  // IP so no test ever collides with another's bucket.
  let ipCounter = 0;
  function randomIp(): string {
    ipCounter += 1;
    return `10.0.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
  }

  async function call(
    method: string,
    path: string,
    opts: { cookie?: string; body?: unknown } = {},
  ): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        "x-forwarded-for": randomIp(),
        ...(opts.cookie ? { cookie: `cred_sid=${opts.cookie}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    };
    return app.fetch(new Request(`http://localhost${path}`, init));
  }

  async function seedStaff(): Promise<{ sid: string; userId: string; workspaceId: string }> {
    const [ws] = await db()
      .insert(schema.workspaces)
      .values({ name: "Agency", slug: "agency", type: "agency" })
      .returning({ id: schema.workspaces.id });
    const [user] = await db()
      .insert(schema.users)
      .values({ email: "s@a.example", name: "Staff", emailVerifiedAt: new Date() })
      .returning({ id: schema.users.id });
    await db()
      .insert(schema.memberships)
      .values({ userId: user!.id, workspaceId: ws!.id, role: "owner" });
    const sid = await createSession({
      userId: user!.id,
      email: "s@a.example",
      activeWorkspaceId: ws!.id,
    });
    return { sid, userId: user!.id, workspaceId: ws!.id };
  }

  // ─── GET /health/ready ─────────────────────────────────────────────────
  describe("GET /health/ready", () => {
    it("returns 200 when DB reachable", async () => {
      const res = await call("GET", "/health/ready");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBeTruthy();
    });
  });

  // ─── POST /v1/marketing/leads ──────────────────────────────────────────
  describe("POST /v1/marketing/leads", () => {
    it("beta lead with volume → 201 + persisted row", async () => {
      const res = await call("POST", "/v1/marketing/leads", {
        body: {
          kind: "beta",
          email: "lead@example.com",
          fullName: "Lead Person",
          agency: "Northstar",
          volume: "11-30",
          role: "Director",
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { ok: boolean; id: string };
      expect(body.ok).toBe(true);
      const rows = await db()
        .select({ email: schema.marketingLeads.email, kind: schema.marketingLeads.kind })
        .from(schema.marketingLeads);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.email).toBe("lead@example.com");
      expect(rows[0]?.kind).toBe("beta");
    });

    it("beta lead WITHOUT volume → 400 (explicit UX check)", async () => {
      const res = await call("POST", "/v1/marketing/leads", {
        body: {
          kind: "beta",
          email: "lead@example.com",
          fullName: "Lead Person",
          agency: "Northstar",
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { type: string };
      expect(body.type).toContain("missing-volume");
    });

    it("demo lead without volume → 201 (only beta requires it)", async () => {
      const res = await call("POST", "/v1/marketing/leads", {
        body: {
          kind: "demo",
          email: "lead@example.com",
          fullName: "Lead Person",
          agency: "Northstar",
        },
      });
      expect(res.status).toBe(201);
    });

    it("normalizes email to lowercase on insert", async () => {
      // zod's .email() rejects surrounding whitespace, so we can only
      // exercise the lower-casing branch of the handler's normalization.
      await call("POST", "/v1/marketing/leads", {
        body: {
          kind: "demo",
          email: "MixedCase@Example.COM",
          fullName: "Lead Person",
          agency: "Northstar",
        },
      });
      const rows = await db()
        .select({ email: schema.marketingLeads.email })
        .from(schema.marketingLeads);
      expect(rows[0]?.email).toBe("mixedcase@example.com");
    });

    it("invalid email → 400", async () => {
      const res = await call("POST", "/v1/marketing/leads", {
        body: { kind: "demo", email: "not-an-email", fullName: "x", agency: "y" },
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── POST /v1/support/report ───────────────────────────────────────────
  describe("POST /v1/support/report", () => {
    it("staff session → 2xx, ticket id returned", async () => {
      const s = await seedStaff();
      const res = await call("POST", "/v1/support/report", {
        cookie: s.sid,
        body: {
          severity: "bug",
          subject: "Something broke",
          body: "Steps to reproduce...",
          pageUrl: "https://example.com/x",
        },
      });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      const body = (await res.json()) as { ticketId: string };
      expect(body.ticketId).toMatch(/^sup_/);
    });

    it("no session → 401", async () => {
      const res = await call("POST", "/v1/support/report", {
        body: { severity: "bug", subject: "X", body: "Y" },
      });
      expect(res.status).toBe(401);
    });

    it("invalid severity → 400 (zod)", async () => {
      const s = await seedStaff();
      const res = await call("POST", "/v1/support/report", {
        cookie: s.sid,
        body: { severity: "not_a_severity", subject: "X", body: "Y" },
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── GET /cockpit/metrics/baseline ─────────────────────────────────────
  describe("GET /cockpit/metrics/baseline", () => {
    // Documents a real bug: metrics.ts:56 passes a JS Date into a raw
    // sql`` template, and postgres-js's parameter binder rejects it
    // ("Received an instance of Date"). Every staff request currently
    // 500s. Marked `it.fails` — the marker flips red the moment
    // someone converts `since` to an ISO string / postgres literal.
    it.fails("staff session → 200 with numeric KPIs (KNOWN BUG — Date binder)", async () => {
      const s = await seedStaff();
      const res = await call("GET", "/cockpit/metrics/baseline", { cookie: s.sid });
      expect(res.status).toBe(200);
    });

    it("no session → 401", async () => {
      const res = await call("GET", "/cockpit/metrics/baseline");
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /v1/workspace/me ──────────────────────────────────────────────
  describe("GET /v1/workspace/me", () => {
    it("staff session with active workspace → 200 with branding", async () => {
      const s = await seedStaff();
      const res = await call("GET", "/v1/workspace/me", { cookie: s.sid });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        type: string;
        branding: { displayName: string };
      };
      expect(body.id).toBe(s.workspaceId);
      expect(body.type).toBe("agency");
      expect(body.branding.displayName).toBe("Agency");
    });

    it("staff session with NO active workspace → 404", async () => {
      const [user] = await db()
        .insert(schema.users)
        .values({ email: "u@a.example", name: "U", emailVerifiedAt: new Date() })
        .returning({ id: schema.users.id });
      const sid = await createSession({
        userId: user!.id,
        email: "u@a.example",
        activeWorkspaceId: null,
      });
      const res = await call("GET", "/v1/workspace/me", { cookie: sid });
      expect(res.status).toBe(404);
    });

    it("no session → 401", async () => {
      const res = await call("GET", "/v1/workspace/me");
      expect(res.status).toBe(401);
    });

    it("activeWorkspaceId points at a deleted workspace → 404", async () => {
      const s = await seedStaff();
      await db().delete(schema.workspaces).where(eq(schema.workspaces.id, s.workspaceId));
      const res = await call("GET", "/v1/workspace/me", { cookie: s.sid });
      expect(res.status).toBe(404);
    });
  });
});

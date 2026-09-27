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
const { createSession, createProviderSession, closeSessionStore } = await import("@cred/auth");
const { db, schema, closeDb } = await import("@cred/db");

const EMPTY_REQS = {
  required_documents: [],
  required_verifications: [],
  privilege_delineations: [],
  attestations: [],
  submission: { method: "email" as const },
  facility_forms: [],
};

const app = buildApp();

/**
 * /me widening: accept both staff and provider session shapes so
 * getViewer() on the FE has a single unified surface. A magic-link
 * provider session used to 401 /me, which sent /welcome into a
 * /signin redirect loop.
 */
describe("/me — session-kind handling", () => {
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

  it("staff session returns memberships + providerId", async () => {
    const [ws] = await db()
      .insert(schema.workspaces)
      .values({ name: "Agency", slug: "agency", type: "agency" })
      .returning({ id: schema.workspaces.id });
    const [user] = await db()
      .insert(schema.users)
      .values({ email: "s@example.com", name: "Staff User", emailVerifiedAt: new Date() })
      .returning({ id: schema.users.id });
    await db()
      .insert(schema.memberships)
      .values({ userId: user!.id, workspaceId: ws!.id, role: "owner" });

    const sid = await createSession({
      userId: user!.id,
      email: "s@example.com",
      activeWorkspaceId: null,
    });
    const res = await app.fetch(
      new Request("http://localhost/me", { headers: { cookie: `cred_sid=${sid}` } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      email: string;
      name: string | null;
      providerId: string | null;
      memberships: Array<{ workspaceId: string }>;
    };
    expect(body.email).toBe("s@example.com");
    expect(body.name).toBe("Staff User");
    expect(body.providerId).toBeNull();
    expect(body.memberships[0]?.workspaceId).toBe(ws!.id);
  });

  it("staff session falls back to provider first/last name when users.name is null", async () => {
    const [user] = await db()
      .insert(schema.users)
      .values({ email: "p@example.com", emailVerifiedAt: new Date() })
      .returning({ id: schema.users.id });
    const [provider] = await db()
      .insert(schema.providers)
      .values({
        email: "p@example.com",
        firstName: "Legacy",
        lastName: "Provider",
        userId: user!.id,
      })
      .returning({ id: schema.providers.id });
    const sid = await createSession({
      userId: user!.id,
      email: "p@example.com",
      activeWorkspaceId: null,
    });
    const res = await app.fetch(
      new Request("http://localhost/me", { headers: { cookie: `cred_sid=${sid}` } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string | null; providerId: string | null };
    expect(body.name).toBe("Legacy Provider");
    expect(body.providerId).toBe(provider!.id);
  });

  it("provider magic-link session returns a minimal viewer (not 401)", async () => {
    const [ws] = await db()
      .insert(schema.workspaces)
      .values({ name: "Agency", slug: "agency", type: "agency" })
      .returning({ id: schema.workspaces.id });
    const [provider] = await db()
      .insert(schema.providers)
      .values({
        email: "magic@example.com",
        firstName: "Magic",
        lastName: "Provider",
        userId: null,
      })
      .returning({ id: schema.providers.id });
    const [facility] = await db()
      .insert(schema.facilities)
      .values({ name: "Test" })
      .returning({ id: schema.facilities.id });
    const [profile] = await db()
      .insert(schema.facilityProfiles)
      .values({
        facilityId: facility!.id,
        workspaceId: ws!.id,
        version: 1,
        status: "approved",
        requirements: EMPTY_REQS,
      })
      .returning({ id: schema.facilityProfiles.id });
    const [cs] = await db()
      .insert(schema.cases)
      .values({
        workspaceId: ws!.id,
        providerId: provider!.id,
        facilityProfileId: profile!.id,
        facilityProfileVersion: "1",
        specialty: "Peds",
        purpose: "initial_appointment",
        status: "awaiting_provider",
      })
      .returning({ id: schema.cases.id });
    const sid = await createProviderSession({
      providerId: provider!.id,
      caseId: cs!.id,
      caseWorkspaceId: ws!.id,
    });
    const res = await app.fetch(
      new Request("http://localhost/me", { headers: { cookie: `cred_sid=${sid}` } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      email: string;
      name: string | null;
      providerId: string | null;
      memberships: unknown[];
    };
    expect(body.providerId).toBe(provider!.id);
    expect(body.name).toBe("Magic Provider");
    expect(body.memberships).toEqual([]);
  });

  it("401 without a session", async () => {
    const res = await app.fetch(new Request("http://localhost/me"));
    expect(res.status).toBe(401);
  });
});

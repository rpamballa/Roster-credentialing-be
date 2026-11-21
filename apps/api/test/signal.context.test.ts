// Agency-local context storage HTTP contract — one file per surface
// (config, knowledge, credentials, gaps) plus the cross-cutting
// isolation checks.
//
// Mirrors the setup of signal.wsA.test.ts / signal.jobsList.test.ts
// so the gating flag + session seed stay consistent.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-session-secret-1234567890";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cred:cred@localhost:5432/cred_test";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";
process.env.API_PUBLIC_URL = "http://localhost:3001";
process.env.WEB_PUBLIC_URL = "http://localhost:3000";
process.env.SIGNAL_SERVICES_ENABLED = "true";

const { ensureSchema } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL);

const { buildApp } = await import("../src/app.js");
const { createSession, closeSessionStore } = await import("@cred/auth");
const { resetEnvForTesting } = await import("@cred/config");
const { db, schema, closeDb } = await import("@cred/db");
const { decryptCredential } = await import("@cred/signal-knowledge");

async function clearAll(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await sql.unsafe(`
      TRUNCATE
        signal_knowledge_chunks,
        signal_knowledge_documents,
        signal_adapter_credentials,
        signal_onboarding_gaps,
        signal_workspace_config,
        signal_eval_runs,
        signal_weights,
        signal_overrides,
        signal_rankings,
        signal_extracts,
        signal_conversations,
        signal_credentials,
        signal_source_lineage,
        signal_jobs,
        signal_providers,
        audit_log,
        memberships,
        workspaces,
        users
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

interface WsSeed {
  workspaceId: string;
  userId: string;
  sid: string;
}

async function seedWs(slug: string): Promise<WsSeed> {
  const [ws] = await db()
    .insert(schema.workspaces)
    .values({ name: `Agency ${slug}`, slug, type: "agency", signalEnabled: true })
    .returning({ id: schema.workspaces.id });
  const [user] = await db()
    .insert(schema.users)
    .values({ email: `staff@${slug}.example`, name: `Staff ${slug}`, emailVerifiedAt: new Date() })
    .returning({ id: schema.users.id });
  await db()
    .insert(schema.memberships)
    .values({ userId: user!.id, workspaceId: ws!.id, role: "owner" });
  const sid = await createSession({
    userId: user!.id,
    email: `staff@${slug}.example`,
    activeWorkspaceId: ws!.id,
  });
  return { workspaceId: ws!.id, userId: user!.id, sid };
}

function withSession(sid: string): HeadersInit {
  return { cookie: `cred_sid=${sid}`, "content-type": "application/json" };
}

const app = buildApp();

beforeAll(async () => {
  await clearAll();
});

beforeEach(async () => {
  await clearAll();
  resetEnvForTesting();
});

afterAll(async () => {
  await closeSessionStore();
  await closeDb();
});

describe("signal context — config", () => {
  it("PUT appends and GET returns the latest value", async () => {
    const a = await seedWs("cfg-latest");
    const put1 = await app.request("/v1/signal/config/field_mapping/candidate.email", {
      method: "PUT",
      headers: withSession(a.sid),
      body: JSON.stringify({ value: { source: "bullhorn.email" } }),
    });
    expect(put1.status).toBe(201);

    const put2 = await app.request("/v1/signal/config/field_mapping/candidate.email", {
      method: "PUT",
      headers: withSession(a.sid),
      body: JSON.stringify({ value: { source: "greenhouse.primary_email" } }),
    });
    expect(put2.status).toBe(201);

    const get = await app.request("/v1/signal/config/field_mapping/candidate.email", {
      method: "GET",
      headers: withSession(a.sid),
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as { value: { source: string } };
    expect(body.value.source).toBe("greenhouse.primary_email");

    const history = await app.request(
      "/v1/signal/config/field_mapping/candidate.email/history",
      { method: "GET", headers: withSession(a.sid) },
    );
    expect(history.status).toBe(200);
    const h = (await history.json()) as { history: Array<{ value: { source: string } }> };
    expect(h.history.length).toBe(2);
    // Newest-first.
    expect(h.history[0]!.value.source).toBe("greenhouse.primary_email");
    expect(h.history[1]!.value.source).toBe("bullhorn.email");
  });

  it("isolates config between workspaces", async () => {
    const a = await seedWs("cfg-a");
    const b = await seedWs("cfg-b");
    await app.request("/v1/signal/config/playbook/weekend", {
      method: "PUT",
      headers: withSession(a.sid),
      body: JSON.stringify({ value: { note: "A-only" } }),
    });
    // From B's session, same path returns 404.
    const resB = await app.request("/v1/signal/config/playbook/weekend", {
      method: "GET",
      headers: withSession(b.sid),
    });
    expect(resB.status).toBe(404);
    // Listing the scope in B also returns empty.
    const listB = await app.request("/v1/signal/config?scope=playbook", {
      method: "GET",
      headers: withSession(b.sid),
    });
    const listBodyB = (await listB.json()) as { entries: unknown[] };
    expect(listBodyB.entries.length).toBe(0);
  });

  it("401s without a session", async () => {
    const res = await app.request("/v1/signal/config?scope=anything", { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe("signal context — knowledge", () => {
  it("upload → search returns the chunk", async () => {
    const a = await seedWs("kb-a");
    const upload = await app.request("/v1/signal/knowledge", {
      method: "POST",
      headers: withSession(a.sid),
      body: JSON.stringify({
        title: "Weekend coverage",
        bodyMarkdown:
          "# Weekend coverage\n\nCall list priority: anesthesia, ortho, cardio.\n\n## Anesthesia\n\nCRNA plus ACLS currency; prefer MA, NH, VT.",
        tags: ["playbook", "coverage"],
      }),
    });
    expect(upload.status).toBe(201);
    const uploadBody = (await upload.json()) as { id: string; chunks: number };
    expect(uploadBody.chunks).toBeGreaterThan(0);

    const search = await app.request("/v1/signal/knowledge/search", {
      method: "POST",
      headers: withSession(a.sid),
      body: JSON.stringify({ query: "weekend anesthesia coverage", limit: 5 }),
    });
    expect(search.status).toBe(200);
    const sBody = (await search.json()) as {
      hits: Array<{ documentTitle: string; score: number }>;
    };
    expect(sBody.hits.length).toBeGreaterThan(0);
    expect(sBody.hits[0]!.documentTitle).toBe("Weekend coverage");
  });

  it("isolates knowledge between workspaces", async () => {
    const a = await seedWs("kb-iso-a");
    const b = await seedWs("kb-iso-b");
    const body =
      "# Playbook\n\nunique_marker_abc123 dictates call priority for anesthesia placements.";
    for (const seed of [a, b]) {
      await app.request("/v1/signal/knowledge", {
        method: "POST",
        headers: withSession(seed.sid),
        body: JSON.stringify({ title: `doc-${seed.workspaceId.slice(0, 4)}`, bodyMarkdown: body }),
      });
    }
    const sA = await app.request("/v1/signal/knowledge/search", {
      method: "POST",
      headers: withSession(a.sid),
      body: JSON.stringify({ query: "unique_marker_abc123", limit: 10 }),
    });
    const jA = (await sA.json()) as { hits: Array<{ documentTitle: string }> };
    expect(jA.hits.length).toBeGreaterThan(0);
    for (const h of jA.hits) {
      expect(h.documentTitle.startsWith(`doc-${a.workspaceId.slice(0, 4)}`)).toBe(true);
    }
    const sB = await app.request("/v1/signal/knowledge/search", {
      method: "POST",
      headers: withSession(b.sid),
      body: JSON.stringify({ query: "unique_marker_abc123", limit: 10 }),
    });
    const jB = (await sB.json()) as { hits: Array<{ documentTitle: string }> };
    for (const h of jB.hits) {
      expect(h.documentTitle.startsWith(`doc-${b.workspaceId.slice(0, 4)}`)).toBe(true);
    }
  });

  it("DELETE soft-deletes and search no longer returns the doc", async () => {
    const a = await seedWs("kb-del");
    const up = await app.request("/v1/signal/knowledge", {
      method: "POST",
      headers: withSession(a.sid),
      body: JSON.stringify({
        title: "to-delete",
        bodyMarkdown: "# Doc\n\nunique_delete_marker and some other text.",
      }),
    });
    const { id } = (await up.json()) as { id: string };
    const del = await app.request(`/v1/signal/knowledge/${id}`, {
      method: "DELETE",
      headers: withSession(a.sid),
    });
    expect(del.status).toBe(204);
    const search = await app.request("/v1/signal/knowledge/search", {
      method: "POST",
      headers: withSession(a.sid),
      body: JSON.stringify({ query: "unique_delete_marker" }),
    });
    const sBody = (await search.json()) as { hits: unknown[] };
    expect(sBody.hits).toEqual([]);
  });
});

describe("signal context — credentials", () => {
  it("PUT encrypts; GET returns metadata only; decrypt via internal helper roundtrips", async () => {
    const a = await seedWs("cred-roundtrip");
    const put = await app.request("/v1/signal/credentials/bullhorn", {
      method: "PUT",
      headers: withSession(a.sid),
      body: JSON.stringify({ payload: { apiKey: "bh_live_123", username: "alice" } }),
    });
    expect(put.status).toBe(201);
    const putBody = (await put.json()) as { payloadVersion: number };
    expect(putBody.payloadVersion).toBe(1);

    const get = await app.request("/v1/signal/credentials/bullhorn", {
      method: "GET",
      headers: withSession(a.sid),
    });
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as Record<string, unknown>;
    // No decrypted payload in the HTTP response.
    expect(getBody).not.toHaveProperty("apiKey");
    expect(getBody).not.toHaveProperty("payload");
    expect(getBody.adapter).toBe("bullhorn");
    expect(getBody.payloadVersion).toBe(1);

    // Rotation bumps the version.
    const put2 = await app.request("/v1/signal/credentials/bullhorn", {
      method: "PUT",
      headers: withSession(a.sid),
      body: JSON.stringify({ payload: { apiKey: "bh_live_456", username: "alice" } }),
    });
    const put2Body = (await put2.json()) as { payloadVersion: number };
    expect(put2Body.payloadVersion).toBe(2);

    // The in-process decrypt roundtrips the latest value via the
    // scoped DAL (same path the ingestion runner uses).
    const { withWorkspace } = await import("@cred/db/signal");
    const scoped = withWorkspace(a.workspaceId);
    const full = await scoped.adapterCredentials.getFull("bullhorn");
    expect(full).toBeDefined();
    const back = decryptCredential(a.workspaceId, "bullhorn", full!.encryptedPayload);
    expect(back).toEqual({ apiKey: "bh_live_456", username: "alice" });
  });

  it("isolates adapter credentials between workspaces", async () => {
    const a = await seedWs("cred-iso-a");
    const b = await seedWs("cred-iso-b");
    await app.request("/v1/signal/credentials/bullhorn", {
      method: "PUT",
      headers: withSession(a.sid),
      body: JSON.stringify({ payload: { apiKey: "A" } }),
    });
    const resB = await app.request("/v1/signal/credentials/bullhorn", {
      method: "GET",
      headers: withSession(b.sid),
    });
    expect(resB.status).toBe(404);
  });

  it("DELETE removes the row", async () => {
    const a = await seedWs("cred-del");
    await app.request("/v1/signal/credentials/gmail", {
      method: "PUT",
      headers: withSession(a.sid),
      body: JSON.stringify({ payload: { token: "x" } }),
    });
    const del = await app.request("/v1/signal/credentials/gmail", {
      method: "DELETE",
      headers: withSession(a.sid),
    });
    expect(del.status).toBe(204);
    const get = await app.request("/v1/signal/credentials/gmail", {
      method: "GET",
      headers: withSession(a.sid),
    });
    expect(get.status).toBe(404);
  });
});

describe("signal context — gaps", () => {
  it("CRUDs a gap row", async () => {
    const a = await seedWs("gaps-a");
    const create = await app.request("/v1/signal/gaps", {
      method: "POST",
      headers: withSession(a.sid),
      body: JSON.stringify({
        title: "No Bullhorn candidate stage",
        bodyMarkdown: "The adapter reads status but not stage; map stage → status for now.",
      }),
    });
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as { id: string };

    const list = await app.request("/v1/signal/gaps", {
      method: "GET",
      headers: withSession(a.sid),
    });
    const listBody = (await list.json()) as { gaps: Array<{ id: string; status: string }> };
    expect(listBody.gaps.length).toBe(1);
    expect(listBody.gaps[0]!.status).toBe("open");

    const patch = await app.request(`/v1/signal/gaps/${id}`, {
      method: "PATCH",
      headers: withSession(a.sid),
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { status: string; resolvedAt: string | null };
    expect(patched.status).toBe("resolved");
    expect(patched.resolvedAt).not.toBeNull();

    const del = await app.request(`/v1/signal/gaps/${id}`, {
      method: "DELETE",
      headers: withSession(a.sid),
    });
    expect(del.status).toBe(204);
  });

  it("isolates gaps between workspaces", async () => {
    const a = await seedWs("gaps-iso-a");
    const b = await seedWs("gaps-iso-b");
    const create = await app.request("/v1/signal/gaps", {
      method: "POST",
      headers: withSession(a.sid),
      body: JSON.stringify({ title: "A-only", bodyMarkdown: "..." }),
    });
    const { id } = (await create.json()) as { id: string };
    const getB = await app.request(`/v1/signal/gaps/${id}`, {
      method: "GET",
      headers: withSession(b.sid),
    });
    expect(getB.status).toBe(404);
    const listB = await app.request("/v1/signal/gaps", {
      method: "GET",
      headers: withSession(b.sid),
    });
    const listBodyB = (await listB.json()) as { gaps: unknown[] };
    expect(listBodyB.gaps.length).toBe(0);
  });
});

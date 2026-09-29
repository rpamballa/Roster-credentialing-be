import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-session-secret-1234567890";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cred:cred@localhost:5432/cred_test";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";
process.env.API_PUBLIC_URL = "http://localhost:3001";
process.env.WEB_PUBLIC_URL = "http://localhost:3000";
// Point the object-storage adapter at the fake-gcs emulator on the
// alt test port. The GCSAdapter forwards this into the storage SDK's
// STORAGE_EMULATOR_HOST at construction time.
process.env.STORAGE_EMULATOR_HOST = process.env.STORAGE_EMULATOR_HOST ?? "http://localhost:54443";
process.env.GCS_BUCKET = process.env.GCS_BUCKET ?? "cred-dev";

const { ensureSchema, truncateAll } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL);

const { buildApp } = await import("../src/app.js");
const { closeSessionStore } = await import("@cred/auth");
const { db, schema, closeDb } = await import("@cred/db");
const { eq } = await import("drizzle-orm");

const app = buildApp();

/**
 * POST /webhooks/email/inbound — Resend delivers parsed MIME here. External
 * attack surface: anyone on the internet can hit this. Two big properties:
 *   - In prod, a missing `resend-signature` header must 401.
 *   - Unknown-recipient path must still 200 (so Resend doesn't retry
 *     forever) but persist the row with workspace_id=null and skip the
 *     Temporal workflow.
 *
 * The known-recipient path goes on to start a Temporal workflow, which
 * this test doesn't attempt to spin up. That path is exercised
 * end-to-end by the ingest integration suite.
 */
describe("POST /webhooks/email/inbound", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  afterEach(() => {
    // Reset any NODE_ENV mutation between tests.
    process.env.NODE_ENV = "test";
  });
  afterAll(async () => {
    await closeDb();
    await closeSessionStore();
  });

  let ipCounter = 0;
  function uniqueIp(): string {
    ipCounter += 1;
    return `10.1.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
  }

  async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return app.fetch(
      new Request("http://localhost/webhooks/email/inbound", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": uniqueIp(),
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
  }

  it("unknown recipient → 200, row persisted with workspaceId=null, no temporal", async () => {
    const res = await post({
      to: ["unknown@no-workspace.example"],
      from: "sender@example.com",
      subject: "Random inbound",
      text: "hello",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; inboundEmailId: string };
    expect(body.ok).toBe(true);

    const rows = await db()
      .select({
        id: schema.inboundEmails.id,
        workspaceId: schema.inboundEmails.workspaceId,
        recipient: schema.inboundEmails.recipient,
      })
      .from(schema.inboundEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspaceId).toBeNull();
    expect(rows[0]?.recipient).toBe("unknown@no-workspace.example");

    // Audit row written with workspaceId=null.
    const audits = await db()
      .select({ action: schema.auditLog.action, workspaceId: schema.auditLog.workspaceId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetEntityId, body.inboundEmailId));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("inbound_email.received");
    expect(audits[0]?.workspaceId).toBeNull();
  });

  it("empty `to` array → 400 (zod)", async () => {
    const res = await post({ to: [], from: "sender@example.com" });
    expect(res.status).toBe(400);
  });

  it("missing `from` → 400 (zod)", async () => {
    const res = await post({ to: ["x@example.com"] });
    expect(res.status).toBe(400);
  });

  // The signature-check branch guards on `env().NODE_ENV === "production"`.
  // env() is cached at first-read in this process, so we can't flip
  // NODE_ENV mid-suite to exercise the prod branch — the cached value
  // stays "test". The branch is small (four lines checking header
  // presence), and a real signature-verification wire-up will need a
  // dedicated test file that boots the app under a prod-flagged
  // config. Skipped here rather than silently green.
  it.skip("in production, no `resend-signature` header → 401 — needs prod-boot fixture", () => {});

  it("payload with attachments → attachmentKeys stored on the row", async () => {
    const res = await post({
      to: ["u@no-ws.example"],
      from: "s@example.com",
      subject: "with pdf",
      attachments: [
        {
          filename: "packet.pdf",
          content_type: "application/pdf",
          content: Buffer.from("hello").toString("base64"),
        },
      ],
    });
    expect(res.status).toBe(200);
    const rows = await db()
      .select({ attachmentKeys: schema.inboundEmails.attachmentKeys })
      .from(schema.inboundEmails);
    expect(rows[0]?.attachmentKeys).toBeTruthy();
    const keys = rows[0]?.attachmentKeys as string[] | null;
    expect(keys?.length).toBe(1);
    expect(keys?.[0]).toMatch(/packet\.pdf$/);
  });
});

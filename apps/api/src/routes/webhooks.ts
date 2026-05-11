import { env } from "@cred/config";
import { db, schema } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { getObjectStorage } from "@cred/storage";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { temporal } from "../services/temporal.js";
import type { ApiBindings } from "../types.js";

export const webhookRoutes = new Hono<ApiBindings>();

// Resend inbound email schema (subset we depend on). Resend posts the full
// MIME payload + parsed structure; we persist the raw payload as-is and
// store attachments separately.
const ResendInboundSchema = z.object({
  to: z.array(z.string()).min(1),
  from: z.string(),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        content_type: z.string(),
        content: z.string(), // base64
      }),
    )
    .optional(),
});

webhookRoutes.post(
  "/webhooks/email/inbound",
  zValidator("json", ResendInboundSchema),
  async (c) => {
    // Resend signs webhook payloads via the `resend-signature` header. Verify
    // it before trusting any content. (Stub for now — wire up signature
    // verification when the Resend webhook secret is provisioned.)
    if (env().NODE_ENV === "production") {
      const sig = c.req.header("resend-signature");
      if (!sig) {
        return c.json({ type: "about:blank", title: "Missing signature", status: 401 }, 401);
      }
    }

    const payload = c.req.valid("json");

    // Resolve recipient to workspace via emailInAddress.
    const recipient = payload.to[0];
    if (!recipient) {
      return c.json({ type: "about:blank", title: "No recipient", status: 400 }, 400);
    }

    // rls: bypass — webhook is anonymous; lookup the workspace by inbound
    // address before establishing tenancy.
    const ws = await db()
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.emailInAddress, recipient))
      .limit(1);

    const workspaceId = ws[0]?.id ?? null;
    const storage = getObjectStorage();

    // Persist raw payload.
    const rawKey = `inbound/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.json`;
    const rawBlob = Buffer.from(JSON.stringify(payload));
    await storage.putSignedUrl({ key: rawKey, contentType: "application/json" });
    // For dev/M3 we use a direct put. In prod, a sidecar lambda or a stream
    // writer handles the bytes — the put-signed-url path is only useful to
    // the original sender. Use a small upload helper here.
    await directPut(rawKey, rawBlob, "application/json");

    // Persist attachments individually.
    const attachmentKeys: string[] = [];
    for (const att of payload.attachments ?? []) {
      const key = `inbound/${rawKey.replace(/\.json$/, "")}/${att.filename}`;
      await directPut(key, Buffer.from(att.content, "base64"), att.content_type);
      attachmentKeys.push(key);
    }

    // rls: bypass — webhook write with explicit workspaceId.
    const [row] = await db()
      .insert(schema.inboundEmails)
      .values({
        workspaceId,
        recipient,
        fromAddress: payload.from,
        subject: payload.subject ?? null,
        rawPayloadUri: rawKey,
        attachmentKeys,
      })
      .returning({ id: schema.inboundEmails.id });
    if (!row) throw new Error("failed to persist inbound email");

    await audit({
      workspaceId,
      actorUserId: null,
      actorType: "system",
      action: "inbound_email.received",
      targetEntityType: "inbound_email",
      targetEntityId: row.id,
      after: {
        recipient,
        from: payload.from,
        attachmentCount: attachmentKeys.length,
      },
      requestId: c.var.requestId,
    });

    if (workspaceId) {
      const client = await temporal();
      await client.workflow.start("facilityIngestWorkflow", {
        taskQueue: env().TEMPORAL_TASK_QUEUE,
        workflowId: `facility-ingest-${row.id}`,
        args: [{ inboundEmailId: row.id, workspaceId }],
      });
    } else {
      logger.warn({ recipient }, "inbound_email_unknown_workspace");
    }

    return c.json({ ok: true, inboundEmailId: row.id });
  },
);

async function directPut(key: string, body: Buffer, contentType: string): Promise<void> {
  // The S3 adapter only exposes signed URLs publicly. For server-internal
  // writes we use the SDK directly via a fresh client. To avoid coupling
  // here, we go through the signed URL and PUT to it.
  const presign = await getObjectStorage().putSignedUrl({
    key,
    contentType,
    expiresInSeconds: 120,
  });
  const resp = await fetch(presign.url, {
    method: "PUT",
    headers: { "content-type": contentType, ...presign.headers },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`failed to store inbound payload: ${resp.status} ${text}`);
  }
}

import { randomBytes } from "node:crypto";
import { db, schema } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireStaffAuth } from "../middleware/session.js";
import { notifySupportTicket } from "../services/notifySupportTicket.js";
import type { ApiBindings } from "../types.js";

const SupportBody = z.object({
  severity: z.enum(["blocker", "bug", "question", "feature"]),
  subject: z.string().min(3).max(200),
  body: z.string().min(3).max(4000),
  pageUrl: z.string().url().max(500).optional(),
  caseId: z.string().uuid().optional(),
});

export const supportRoutes = new Hono<ApiBindings>();

supportRoutes.use("/v1/support/*", requireStaffAuth);

supportRoutes.post("/v1/support/report", zValidator("json", SupportBody), async (c) => {
  const auth = c.var.staffAuth;
  const body = c.req.valid("json");

  // Ticket id — short + human-copyable ("sup_a4b2c8"), collision risk
  // negligible at our volume.
  const ticketId = `sup_${randomBytes(3).toString("hex")}`;
  const receivedAt = new Date().toISOString();

  // Resolve the caller's workspace + email in one query so the ticket
  // payload includes context the operator needs on Slack. rls: bypass —
  // this is the authenticated user's own row and their own membership.
  const [ctx] = await db()
    .select({
      email: schema.users.email,
      workspaceSlug: schema.workspaces.slug,
      workspaceName: schema.workspaces.name,
      role: schema.memberships.role,
    })
    .from(schema.users)
    .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
    .where(eq(schema.users.id, auth.session.userId))
    .limit(1);

  const workspaceLabel = ctx?.workspaceName ?? ctx?.workspaceSlug ?? "(unknown)";

  // Audit targetEntityId is UUID-typed; support tickets have their own
  // opaque id space (see `ticketId` above). Store the nil UUID as target
  // and surface the readable ticket id via the `after` payload.
  await audit({
    workspaceId: null,
    actorUserId: auth.session.userId,
    actorType: "user",
    action: "support.ticket_filed",
    targetEntityType: "support_ticket",
    targetEntityId: "00000000-0000-0000-0000-000000000000",
    after: {
      ticketId,
      severity: body.severity,
      subject: body.subject,
      pageUrl: body.pageUrl ?? null,
      caseId: body.caseId ?? null,
    },
    requestId: c.var.requestId,
  });

  logger.info(
    { ticketId, severity: body.severity, workspace: workspaceLabel },
    "support_ticket_filed",
  );

  // Fire-and-forget fan-out to Sheet + Slack. The ticket is already
  // durably in the audit log, so a webhook failure doesn't lose the
  // report — the response returns immediately.
  void notifySupportTicket({
    ticketId,
    receivedAt,
    workspace: workspaceLabel,
    userEmail: ctx?.email ?? "(unknown)",
    role: ctx?.role ?? "(unknown)",
    severity: body.severity,
    subject: body.subject,
    body: body.body,
    pageUrl: body.pageUrl ?? null,
    caseId: body.caseId ?? null,
  });

  return c.json({ ticketId, receivedAt }, 201);
});

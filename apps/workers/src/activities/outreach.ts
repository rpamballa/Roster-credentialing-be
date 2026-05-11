import { sendEmail, sendSms } from "@cred/auth";
import { db, schema } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { and, eq } from "drizzle-orm";

export interface OutreachContext {
  threadId: string;
  workspaceId: string;
}

interface RecipientChannels {
  email: string | null;
  phone: string | null;
  status: string;
  caseId: string;
}

async function loadThread(threadId: string): Promise<RecipientChannels | null> {
  // rls: bypass — activity loads thread by id via trusted workflow input.
  const [row] = await db()
    .select({
      email: schema.outreachThreads.recipientEmail,
      phone: schema.outreachThreads.recipientPhone,
      status: schema.outreachThreads.status,
      caseId: schema.outreachThreads.caseId,
    })
    .from(schema.outreachThreads)
    .where(eq(schema.outreachThreads.id, threadId))
    .limit(1);
  return row ?? null;
}

async function recordMessage(params: {
  threadId: string;
  workspaceId: string;
  channel: "email" | "sms";
  template: string;
  body: string;
}): Promise<void> {
  // rls: bypass — activity write with explicit workspaceId.
  await db().insert(schema.outreachMessages).values({
    threadId: params.threadId,
    workspaceId: params.workspaceId,
    channel: params.channel,
    direction: "out",
    template: params.template,
    body: params.body,
    sentAt: new Date(),
  });
}

export async function sendInviteActivity(ctx: OutreachContext): Promise<{ sent: boolean }> {
  const t = await loadThread(ctx.threadId);
  if (!t || t.status !== "active") return { sent: false };

  const body = `Your credentialing packet is ready. Open: ${t.caseId}`;
  if (t.email) {
    await sendEmail({ to: t.email, subject: "Credentialing packet ready", text: body });
    await recordMessage({ ...ctx, channel: "email", template: "invite", body });
  } else if (t.phone) {
    await sendSms({ to: t.phone, body });
    await recordMessage({ ...ctx, channel: "sms", template: "invite", body });
  } else {
    logger.warn({ threadId: ctx.threadId }, "outreach_no_channel");
    return { sent: false };
  }
  await audit({
    workspaceId: ctx.workspaceId,
    actorUserId: null,
    actorType: "system",
    action: "outreach.invite_sent",
    targetEntityType: "outreach_thread",
    targetEntityId: ctx.threadId,
  });
  return { sent: true };
}

export async function sendReminderActivity(
  ctx: OutreachContext & { channel: "email" | "sms"; template: string },
): Promise<{ sent: boolean }> {
  const t = await loadThread(ctx.threadId);
  if (!t || t.status !== "active") return { sent: false };

  const body = "Reminder: your credentialing items are still pending. Please complete them.";
  if (ctx.channel === "sms" && t.phone) {
    await sendSms({ to: t.phone, body });
    await recordMessage({ ...ctx, channel: "sms", template: ctx.template, body });
  } else if (t.email) {
    await sendEmail({ to: t.email, subject: "Credentialing reminder", text: body });
    await recordMessage({ ...ctx, channel: "email", template: ctx.template, body });
  } else {
    return { sent: false };
  }
  await audit({
    workspaceId: ctx.workspaceId,
    actorUserId: null,
    actorType: "system",
    action: "outreach.reminder_sent",
    targetEntityType: "outreach_thread",
    targetEntityId: ctx.threadId,
    after: { template: ctx.template, channel: ctx.channel },
  });
  return { sent: true };
}

export async function alertSpecialistActivity(ctx: OutreachContext): Promise<void> {
  const t = await loadThread(ctx.threadId);
  if (!t) return;

  // Find the case's assigned specialist; if none, audit-only.
  // rls: bypass — internal lookup gated by the workflow workspace context.
  const [c] = await db()
    .select({ specialistId: schema.cases.assignedSpecialistId })
    .from(schema.cases)
    .where(and(eq(schema.cases.id, t.caseId), eq(schema.cases.workspaceId, ctx.workspaceId)))
    .limit(1);

  await audit({
    workspaceId: ctx.workspaceId,
    actorUserId: c?.specialistId ?? null,
    actorType: "system",
    action: "outreach.specialist_alert",
    targetEntityType: "outreach_thread",
    targetEntityId: ctx.threadId,
    after: { caseId: t.caseId },
  });

  if (c?.specialistId) {
    // rls: bypass — look up the specialist's email to notify them.
    const [u] = await db()
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, c.specialistId))
      .limit(1);
    if (u?.email) {
      await sendEmail({
        to: u.email,
        subject: "Outreach stalled — specialist action needed",
        text: `Case ${t.caseId}: provider hasn't responded after the reminder cadence. Review the case.`,
      });
    }
  }
}

export async function isThreadActive(ctx: OutreachContext): Promise<boolean> {
  const t = await loadThread(ctx.threadId);
  return !!t && t.status === "active";
}

export async function completeThreadActivity(ctx: OutreachContext): Promise<void> {
  // rls: bypass — completion write keyed by id, audited.
  await db()
    .update(schema.outreachThreads)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(schema.outreachThreads.id, ctx.threadId));

  await audit({
    workspaceId: ctx.workspaceId,
    actorUserId: null,
    actorType: "system",
    action: "outreach.completed",
    targetEntityType: "outreach_thread",
    targetEntityId: ctx.threadId,
  });
}

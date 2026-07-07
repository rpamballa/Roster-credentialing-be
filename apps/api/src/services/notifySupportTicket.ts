import { env } from "@cred/config";
import { logger } from "@cred/observability";

export interface SupportTicketPayload {
  ticketId: string;
  receivedAt: string;
  workspace: string;
  userEmail: string;
  role: string;
  severity: "blocker" | "bug" | "question" | "feature";
  subject: string;
  body: string;
  pageUrl?: string | null;
  caseId?: string | null;
}

/**
 * Fan out a new support ticket to (a) the Google Sheet via Apps Script
 * webhook, (b) the Slack channel via the marketing-leads webhook (we
 * reuse it — one channel to watch), (c) the audit log (always).
 *
 * Every branch is fire-and-forget from the caller's perspective. This
 * function still awaits so the caller can log a warning when a leg
 * fails, but the endpoint doesn't need to bubble failures to the
 * ticket-filer — the ticket is already in the audit log.
 */
export async function notifySupportTicket(payload: SupportTicketPayload): Promise<void> {
  await Promise.all([postToSheet(payload), postToSlack(payload)]);
}

async function postToSheet(payload: SupportTicketPayload): Promise<void> {
  const url = env().SUPPORT_WEBHOOK_URL;
  const token = env().SUPPORT_WEBHOOK_TOKEN;
  if (!url || !token) {
    logger.info({ ticketId: payload.ticketId }, "support_sheet_skipped_no_webhook");
    return;
  }
  try {
    const resp = await fetch(`${url}?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      // Apps Script response can be slow (~2s cold). Don't block the API
      // request on it — the ticket is already persisted in audit.
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      logger.warn(
        { ticketId: payload.ticketId, status: resp.status },
        "support_sheet_post_failed",
      );
    }
  } catch (err) {
    logger.warn({ err, ticketId: payload.ticketId }, "support_sheet_post_threw");
  }
}

async function postToSlack(payload: SupportTicketPayload): Promise<void> {
  const url = env().SLACK_WEBHOOK_URL;
  if (!url) return;

  const emoji =
    payload.severity === "blocker"
      ? ":red_circle:"
      : payload.severity === "bug"
        ? ":large_orange_diamond:"
        : payload.severity === "feature"
          ? ":sparkles:"
          : ":question:";

  const lines = [
    `${emoji} *Support ticket* — \`${payload.ticketId}\` — *${payload.severity}*`,
    `*${payload.workspace}* · ${payload.userEmail} (${payload.role})`,
    `*${payload.subject}*`,
    `> ${payload.body.slice(0, 400)}${payload.body.length > 400 ? "…" : ""}`,
  ];
  if (payload.pageUrl) lines.push(`On: \`${payload.pageUrl}\``);
  if (payload.caseId) lines.push(`Case: \`${payload.caseId}\``);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      logger.warn(
        { ticketId: payload.ticketId, status: resp.status },
        "support_slack_post_failed",
      );
    }
  } catch (err) {
    logger.warn({ err, ticketId: payload.ticketId }, "support_slack_post_threw");
  }
}

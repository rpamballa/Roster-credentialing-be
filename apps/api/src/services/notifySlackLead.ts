import { env } from "@cred/config";
import { logger } from "@cred/observability";

interface SlackLeadPayload {
  kind: "beta" | "demo";
  fullName: string;
  email: string;
  agency: string;
  role?: string | null | undefined;
  volume?: string | null | undefined;
  freeText?: string | null | undefined;
  sourcePath?: string | null | undefined;
}

/**
 * Ping the marketing-leads Slack channel when a new lead arrives.
 *
 * No-op when SLACK_WEBHOOK_URL is unset — the lead is still recorded in
 * marketing_leads and the applicant still gets a confirmation email; the
 * Slack side is purely an internal notification convenience.
 *
 * Fire-and-forget — never block the response on this. Failures are logged.
 */
export async function notifySlackLead(payload: SlackLeadPayload): Promise<void> {
  const url = env().SLACK_WEBHOOK_URL;
  if (!url) {
    logger.info({ kind: payload.kind, agency: payload.agency }, "slack_lead_skipped_no_webhook");
    return;
  }

  const lines = [
    `*New ${payload.kind === "beta" ? "beta application" : "demo request"}*`,
    `*${payload.fullName}* (${payload.email}) — ${payload.agency}`,
  ];
  if (payload.role) lines.push(`Role: ${payload.role}`);
  if (payload.volume) lines.push(`Volume: ${payload.volume}`);
  if (payload.freeText) lines.push(`> ${payload.freeText.slice(0, 400)}`);
  if (payload.sourcePath) lines.push(`Source: \`${payload.sourcePath}\``);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status }, "slack_lead_post_failed");
    }
  } catch (err) {
    logger.warn({ err }, "slack_lead_post_threw");
  }
}

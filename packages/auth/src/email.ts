import { env } from "@cred/config";
import { logger } from "@cred/observability/logger";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

// Dev mode: log the email to stdout instead of calling Resend. This is the
// behavior the M1 "done means" criterion requires.
export async function sendEmail(msg: EmailMessage): Promise<void> {
  const cfg = env();
  if (cfg.NODE_ENV !== "production" || !cfg.RESEND_API_KEY) {
    logger.info({ to: msg.to, subject: msg.subject, body: msg.text }, "email_dev_logged");
    return;
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: cfg.RESEND_FROM_EMAIL,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    logger.error({ status: resp.status, detail }, "resend_send_failed");
    throw new Error(`resend send failed: ${resp.status}`);
  }
}

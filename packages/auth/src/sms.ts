import { env } from "@cred/config";
import { logger } from "@cred/observability/logger";

export interface SmsMessage {
  to: string;
  body: string;
}

export async function sendSms(msg: SmsMessage): Promise<void> {
  const cfg = env();
  if (cfg.NODE_ENV !== "production" || !cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN) {
    logger.info({ to: msg.to, body: msg.body }, "sms_dev_logged");
    return;
  }

  const params = new URLSearchParams({
    From: cfg.TWILIO_FROM_NUMBER ?? "",
    To: msg.to,
    Body: msg.body,
  });

  const credentials = Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString(
    "base64",
  );

  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${credentials}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: params,
    },
  );

  if (!resp.ok) {
    const detail = await resp.text();
    logger.error({ status: resp.status, detail }, "twilio_send_failed");
    throw new Error(`twilio send failed: ${resp.status}`);
  }
}

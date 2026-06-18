import { sendEmail } from "@cred/auth";
import { env } from "@cred/config";
import { db, schema } from "@cred/db";
import { logger } from "@cred/observability";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { notifySlackLead } from "../services/notifySlackLead.js";
import { verifyTurnstile } from "../services/verifyTurnstile.js";
import type { ApiBindings } from "../types.js";

const MarketingLeadSchema = z.object({
  kind: z.enum(["beta", "demo"]),
  email: z.string().email().max(320),
  fullName: z.string().min(1).max(160),
  agency: z.string().min(1).max(160),
  role: z.string().max(160).optional(),
  volume: z.enum(["1-10", "11-30", "31-75", "75+"]).optional(),
  freeText: z.string().max(4000).optional(),
  sourcePath: z.string().max(500).optional(),
  utm: z
    .object({
      source: z.string().max(160).optional(),
      medium: z.string().max(160).optional(),
      campaign: z.string().max(160).optional(),
    })
    .optional(),
  turnstileToken: z.string().max(2048).optional(),
});

export const marketingLeadRoutes = new Hono<ApiBindings>();

marketingLeadRoutes.post(
  "/v1/marketing/leads",
  zValidator("json", MarketingLeadSchema),
  async (c) => {
    const body = c.req.valid("json");
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      null;
    const userAgent = c.req.header("user-agent")?.slice(0, 500) ?? null;

    // `volume` is optional in the schema so /demo can share the endpoint, but
    // a beta application without it is a UX bug — reject explicitly.
    if (body.kind === "beta" && !body.volume) {
      return c.json(
        {
          type: "https://errors.cred/marketing/missing-volume",
          title: "Volume required for beta",
          status: 400,
          instance: c.var.requestId,
        },
        400,
      );
    }

    // Turnstile is a no-op when TURNSTILE_SECRET_KEY is unset; the rate
    // limiter on app.ts is the always-on backstop.
    const turnstile = await verifyTurnstile(body.turnstileToken, ip);
    if (turnstile.configured && !turnstile.passed) {
      return c.json(
        {
          type: "https://errors.cred/marketing/turnstile-failed",
          title: "Verification failed",
          status: 400,
          instance: c.var.requestId,
        },
        400,
      );
    }

    const [row] = await db()
      .insert(schema.marketingLeads)
      .values({
        kind: body.kind,
        email: body.email.toLowerCase().trim(),
        fullName: body.fullName.trim(),
        agency: body.agency.trim(),
        role: body.role?.trim() ?? null,
        volume: body.volume ?? null,
        freeText: body.freeText?.trim() ?? null,
        sourcePath: body.sourcePath ?? null,
        utmSource: body.utm?.source ?? null,
        utmMedium: body.utm?.medium ?? null,
        utmCampaign: body.utm?.campaign ?? null,
        ip,
        userAgent,
        turnstilePassed: turnstile.configured ? turnstile.passed : null,
      })
      .returning({ id: schema.marketingLeads.id });

    const leadId = row?.id;
    logger.info({ leadId, kind: body.kind, agency: body.agency }, "marketing_lead_recorded");

    // Fire-and-forget — the lead is persisted; email/Slack failures shouldn't
    // bubble back to the applicant. Failures land in the logs for follow-up.
    void sendApplicantConfirmation(body).catch((err) =>
      logger.warn({ err, leadId }, "marketing_lead_email_failed"),
    );
    void notifySlackLead({
      kind: body.kind,
      fullName: body.fullName.trim(),
      email: body.email.toLowerCase().trim(),
      agency: body.agency.trim(),
      role: body.role,
      volume: body.volume,
      freeText: body.freeText,
      sourcePath: body.sourcePath,
    });

    return c.json({ ok: true, id: leadId }, 201);
  },
);

async function sendApplicantConfirmation(
  body: z.infer<typeof MarketingLeadSchema>,
): Promise<void> {
  const kind = body.kind;
  const subject =
    kind === "beta"
      ? "Your Roster Healthcare beta application"
      : "Your Roster Healthcare demo request";
  const opener =
    kind === "beta"
      ? "Thanks for applying to the Roster Healthcare beta."
      : "Thanks for requesting a Roster Healthcare demo.";
  const text = [
    `Hi ${firstName(body.fullName)},`,
    "",
    opener,
    "",
    "We review every application personally and will follow up within 48 hours.",
    "Questions in the meantime? Just reply to this email or write to info@rosterhealthcare.com.",
    "",
    "— The Roster Healthcare team",
    env().WEB_PUBLIC_URL,
  ].join("\n");
  await sendEmail({ to: body.email, subject, text });
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
}

import { createHash, randomBytes } from "node:crypto";
import { env } from "@cred/config";
import { db, schema } from "@cred/db";
import { audit } from "@cred/observability/audit";
import { logger } from "@cred/observability/logger";
import { and, eq, isNull, sql } from "drizzle-orm";
import { sendEmail } from "./email.js";

const TOKEN_BYTES = 32;

/** 30 minutes — long enough for a slow inbox, short enough to bound theft. */
const RESET_TTL_MINUTES = 30;

function generate(): { token: string; hash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, hash };
}

export function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class PasswordResetInvalidError extends Error {
  constructor() {
    super("password reset token is invalid, expired, or already used");
    this.name = "PasswordResetInvalidError";
  }
}

export interface RequestResetParams {
  email: string;
  requestIp?: string | null;
}

/**
 * Issue a reset token and email it. **Silent when the email is unknown**
 * — we never expose whether an account exists (account-enumeration
 * defense). The endpoint always returns 200; only real accounts get a
 * token minted and an email sent.
 */
export async function requestPasswordReset(params: RequestResetParams): Promise<void> {
  const cfg = env();
  const email = params.email.trim().toLowerCase();

  // rls: bypass — users is workspace-independent; pre-session lookup.
  const [user] = await db()
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
    .from(schema.users)
    .where(eq(sql`lower(${schema.users.email})`, email))
    .limit(1);

  if (!user) {
    logger.info({ email }, "password_reset_request_unknown_email");
    return;
  }

  const { token, hash } = generate();
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);

  // rls: bypass — password_reset_tokens is not workspace-scoped.
  const [row] = await db()
    .insert(schema.passwordResetTokens)
    .values({
      tokenHash: hash,
      userId: user.id,
      expiresAt,
      requestIp: params.requestIp ?? null,
    })
    .returning({ id: schema.passwordResetTokens.id });
  if (!row) throw new Error("failed to persist password reset token");

  const resetUrl = new URL(`/reset-password/${token}`, cfg.WEB_PUBLIC_URL).toString();
  const displayName = user.name?.trim() || user.email;

  await sendEmail({
    to: user.email,
    subject: "Reset your Roster Healthcare password",
    text: [
      `Hi ${displayName},`,
      "",
      "We received a request to reset your Roster Healthcare password.",
      `Follow this link within the next ${RESET_TTL_MINUTES} minutes to choose a new one:`,
      "",
      resetUrl,
      "",
      "If you didn't request this, you can safely ignore this email — your current password stays active.",
    ].join("\n"),
  });

  await audit({
    workspaceId: null,
    actorUserId: user.id,
    actorType: "user",
    action: "auth.password_reset_requested",
    targetEntityType: "user",
    targetEntityId: user.id,
  });
}

export interface ConsumedPasswordReset {
  userId: string;
  email: string;
}

/**
 * Consume a reset token — single-atomic UPDATE so a double-click can't
 * consume the same token twice. Returns the target user's id + email
 * (caller writes the new hash and mints the session).
 */
export async function consumePasswordReset(token: string): Promise<ConsumedPasswordReset> {
  const hash = hashPasswordResetToken(token);

  // rls: bypass — pre-session token consumption. Guarded by hash + not
  // expired + not already consumed all in one UPDATE predicate.
  const [row] = await db()
    .update(schema.passwordResetTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.passwordResetTokens.tokenHash, hash),
        isNull(schema.passwordResetTokens.consumedAt),
        sql`${schema.passwordResetTokens.expiresAt} > now()`,
      ),
    )
    .returning({ userId: schema.passwordResetTokens.userId });

  if (!row) throw new PasswordResetInvalidError();

  const [user] = await db()
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, row.userId))
    .limit(1);

  if (!user) throw new PasswordResetInvalidError();

  return { userId: user.id, email: user.email };
}

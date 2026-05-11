import { createHash, randomBytes } from "node:crypto";
import { env } from "@cred/config";
import { db, schema } from "@cred/db";
import { audit } from "@cred/observability/audit";
import { logger } from "@cred/observability/logger";
import { and, eq, isNull, sql } from "drizzle-orm";
import { sendEmail } from "./email.js";

const TOKEN_BYTES = 32;

function generateToken(): { token: string; hash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, hash };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssueParams {
  email: string;
  redirectPath?: string;
  requestIp?: string | null;
}

export interface IssueResult {
  tokenId: string;
  expiresAt: Date;
}

/** Issue a magic link, deliver the email, and return the token id. */
export async function issueMagicLink(params: IssueParams): Promise<IssueResult> {
  const cfg = env();
  const { token, hash } = generateToken();
  const expiresAt = new Date(Date.now() + cfg.MAGIC_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);

  // rls: bypass — magic_link_tokens is not workspace-scoped (pre-session).
  const [row] = await db()
    .insert(schema.magicLinkTokens)
    .values({
      tokenHash: hash,
      email: params.email,
      redirectPath: params.redirectPath ?? null,
      expiresAt,
      requestIp: params.requestIp ?? null,
    })
    .returning({ id: schema.magicLinkTokens.id });

  if (!row) throw new Error("failed to persist magic link token");

  const verifyUrl = new URL("/auth/magic-link/verify", cfg.WEB_PUBLIC_URL);
  verifyUrl.searchParams.set("token", token);
  if (params.redirectPath) verifyUrl.searchParams.set("redirect", params.redirectPath);

  await sendEmail({
    to: params.email,
    subject: "Your sign-in link",
    text: `Sign in here: ${verifyUrl.toString()}\n\nThis link expires in ${cfg.MAGIC_LINK_TTL_DAYS} days and can only be used once.`,
  });

  await audit({
    workspaceId: null,
    actorUserId: null,
    actorType: "system",
    action: "auth.magic_link.issued",
    targetEntityType: "user",
    targetEntityId: row.id,
    after: { email: params.email, expiresAt: expiresAt.toISOString() },
    ipAddress: params.requestIp ?? null,
  });

  logger.info({ tokenId: row.id }, "magic_link_issued");
  return { tokenId: row.id, expiresAt };
}

export interface ConsumeResult {
  userId: string;
  email: string;
  redirectPath: string | null;
  isNewUser: boolean;
}

/**
 * Consume a magic-link token. Atomically marks it as consumed so the same
 * token cannot be redeemed twice (the WHERE clause requires consumed_at IS NULL
 * and expires_at > now()).
 */
export async function consumeMagicLink(token: string): Promise<ConsumeResult> {
  const hash = hashToken(token);

  // rls: bypass — pre-session lookup by token hash.
  const updated = await db()
    .update(schema.magicLinkTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.magicLinkTokens.tokenHash, hash),
        isNull(schema.magicLinkTokens.consumedAt),
        sql`${schema.magicLinkTokens.expiresAt} > now()`,
      ),
    )
    .returning({
      id: schema.magicLinkTokens.id,
      email: schema.magicLinkTokens.email,
      redirectPath: schema.magicLinkTokens.redirectPath,
    });

  const row = updated[0];
  if (!row) throw new MagicLinkInvalidError();

  // Upsert the user.
  // rls: bypass — users table is not workspace-scoped.
  const [user] = await db()
    .insert(schema.users)
    .values({ email: row.email, emailVerifiedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.users.email,
      set: { emailVerifiedAt: new Date() },
    })
    .returning({ id: schema.users.id, createdAt: schema.users.createdAt });

  if (!user) throw new Error("failed to upsert user");

  const isNewUser = Date.now() - user.createdAt.getTime() < 5000;

  await audit({
    workspaceId: null,
    actorUserId: user.id,
    actorType: "user",
    action: "auth.magic_link.consumed",
    targetEntityType: "user",
    targetEntityId: user.id,
    after: { isNewUser },
  });

  return {
    userId: user.id,
    email: row.email,
    redirectPath: row.redirectPath,
    isNewUser,
  };
}

export class MagicLinkInvalidError extends Error {
  constructor() {
    super("magic link is invalid, expired, or already used");
    this.name = "MagicLinkInvalidError";
  }
}

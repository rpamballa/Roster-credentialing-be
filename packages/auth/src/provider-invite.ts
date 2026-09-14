import { createHash, randomBytes } from "node:crypto";
import { db, schema } from "@cred/db";
import { audit } from "@cred/observability/audit";
import { and, eq, isNull, sql } from "drizzle-orm";

const TOKEN_BYTES = 32;

function generate(): { token: string; hash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, hash };
}

export interface IssueProviderInviteParams {
  workspaceId: string;
  email: string;
  fullName?: string | null;
  expiresAt: Date;
  invitedByUserId?: string | null;
}

/**
 * Mint a workspace-scoped provider invite token. Persists only the hash;
 * the plaintext token is returned once for embedding in the invite email.
 */
export async function issueProviderInviteToken(
  params: IssueProviderInviteParams,
): Promise<{ token: string; tokenId: string }> {
  const { token, hash } = generate();
  // rls: bypass — invite issuance for a workspace the caller controls; RBAC
  // is enforced at the route layer before we reach this helper.
  const [row] = await db()
    .insert(schema.providerInviteTokens)
    .values({
      tokenHash: hash,
      workspaceId: params.workspaceId,
      email: params.email.trim().toLowerCase(),
      fullName: params.fullName?.trim() || null,
      invitedByUserId: params.invitedByUserId ?? null,
      expiresAt: params.expiresAt,
    })
    .returning({ id: schema.providerInviteTokens.id });
  if (!row) throw new Error("failed to persist provider invite token");

  await audit({
    workspaceId: params.workspaceId,
    actorUserId: params.invitedByUserId ?? null,
    actorType: params.invitedByUserId ? "user" : "system",
    action: "provider_invite.issued",
    targetEntityType: "workspace",
    targetEntityId: params.workspaceId,
    after: {
      email: params.email,
      fullName: params.fullName ?? null,
      expiresAt: params.expiresAt.toISOString(),
    },
  });

  return { token, tokenId: row.id };
}

export interface ProviderInvitePreview {
  workspaceId: string;
  workspaceName: string;
  email: string;
  fullName: string | null;
  expiresAt: Date;
}

export class ProviderInviteInvalidError extends Error {
  constructor() {
    super("provider invite token is invalid, expired, or already redeemed");
    this.name = "ProviderInviteInvalidError";
  }
}

/**
 * Peek at an invite token — landing-page preview. Does NOT consume the
 * token. Returns null-shaped error via the throw, mirroring case-access.
 */
export async function previewProviderInviteToken(token: string): Promise<ProviderInvitePreview> {
  const hash = createHash("sha256").update(token).digest("hex");
  // rls: bypass — pre-session lookup by hash; workspace join needed for
  // the landing page's greeting copy.
  const [row] = await db()
    .select({
      workspaceId: schema.providerInviteTokens.workspaceId,
      email: schema.providerInviteTokens.email,
      fullName: schema.providerInviteTokens.fullName,
      expiresAt: schema.providerInviteTokens.expiresAt,
      workspaceName: schema.workspaces.name,
    })
    .from(schema.providerInviteTokens)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.providerInviteTokens.workspaceId))
    .where(
      and(
        eq(schema.providerInviteTokens.tokenHash, hash),
        isNull(schema.providerInviteTokens.revokedAt),
        isNull(schema.providerInviteTokens.redeemedAt),
        sql`${schema.providerInviteTokens.expiresAt} > now()`,
      ),
    )
    .limit(1);

  if (!row) throw new ProviderInviteInvalidError();
  return row;
}

export interface RedeemedProviderInvite {
  workspaceId: string;
  email: string;
  fullName: string | null;
  providerId: string;
}

/**
 * Redeem an invite token. Consumes the token (single-use) and returns
 * everything the caller needs to upsert the provider row and grant
 * workspace access. The caller — a route handler in provider.ts —
 * writes the providers + provider_workspace_grants rows in the same
 * request, then updates provider_id on the token row.
 */
export async function redeemProviderInviteToken(
  token: string,
): Promise<Omit<RedeemedProviderInvite, "providerId">> {
  const hash = createHash("sha256").update(token).digest("hex");
  // rls: bypass — pre-session redemption path. Single-atomic UPDATE so a
  // double-click can't consume the same token twice.
  const [row] = await db()
    .update(schema.providerInviteTokens)
    .set({ redeemedAt: new Date() })
    .where(
      and(
        eq(schema.providerInviteTokens.tokenHash, hash),
        isNull(schema.providerInviteTokens.revokedAt),
        isNull(schema.providerInviteTokens.redeemedAt),
        sql`${schema.providerInviteTokens.expiresAt} > now()`,
      ),
    )
    .returning({
      workspaceId: schema.providerInviteTokens.workspaceId,
      email: schema.providerInviteTokens.email,
      fullName: schema.providerInviteTokens.fullName,
    });

  if (!row) throw new ProviderInviteInvalidError();
  return row;
}

/**
 * After the caller has upserted the providers row, patch the token with
 * the resolved provider_id so the audit trail can join back later.
 */
export async function attachProviderToInvite(tokenHash: string, providerId: string): Promise<void> {
  await db()
    .update(schema.providerInviteTokens)
    .set({ providerId })
    .where(eq(schema.providerInviteTokens.tokenHash, tokenHash));
}

export function hashProviderInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

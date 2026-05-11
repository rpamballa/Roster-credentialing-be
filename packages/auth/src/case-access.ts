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

export interface IssueCaseAccessParams {
  caseId: string;
  providerId: string;
  workspaceId: string;
  expiresAt: Date;
  issuedByUserId?: string | null;
}

export async function issueCaseAccessToken(
  params: IssueCaseAccessParams,
): Promise<{ token: string; tokenId: string }> {
  const { token, hash } = generate();
  // rls: bypass — token issuance for a case the workspace owns; the caller
  // is already inside the workspace tenancy context at the service layer.
  const [row] = await db()
    .insert(schema.caseAccessTokens)
    .values({
      tokenHash: hash,
      caseId: params.caseId,
      providerId: params.providerId,
      expiresAt: params.expiresAt,
    })
    .returning({ id: schema.caseAccessTokens.id });
  if (!row) throw new Error("failed to persist case access token");

  await audit({
    workspaceId: params.workspaceId,
    actorUserId: params.issuedByUserId ?? null,
    actorType: params.issuedByUserId ? "user" : "system",
    action: "case_access.issued",
    targetEntityType: "case",
    targetEntityId: params.caseId,
    after: { providerId: params.providerId, expiresAt: params.expiresAt.toISOString() },
  });

  return { token, tokenId: row.id };
}

export interface RedeemResult {
  caseId: string;
  providerId: string;
  workspaceId: string;
}

export class CaseAccessInvalidError extends Error {
  constructor() {
    super("case access token is invalid, expired, or revoked");
    this.name = "CaseAccessInvalidError";
  }
}

export async function redeemCaseAccessToken(token: string): Promise<RedeemResult> {
  const hash = createHash("sha256").update(token).digest("hex");
  // rls: bypass — pre-session lookup of a case access token by hash.
  const [row] = await db()
    .update(schema.caseAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(schema.caseAccessTokens.tokenHash, hash),
        isNull(schema.caseAccessTokens.revokedAt),
        sql`${schema.caseAccessTokens.expiresAt} > now()`,
      ),
    )
    .returning({
      caseId: schema.caseAccessTokens.caseId,
      providerId: schema.caseAccessTokens.providerId,
    });

  if (!row) throw new CaseAccessInvalidError();

  // rls: bypass — provider routes need the case's workspace to set tenancy.
  const [c] = await db()
    .select({ workspaceId: schema.cases.workspaceId })
    .from(schema.cases)
    .where(eq(schema.cases.id, row.caseId))
    .limit(1);
  if (!c) throw new CaseAccessInvalidError();

  return { caseId: row.caseId, providerId: row.providerId, workspaceId: c.workspaceId };
}

import { createHash, randomBytes } from "node:crypto";
import { db, schema } from "@cred/db";
import { audit } from "@cred/observability/audit";
import { and, eq, isNull, sql } from "drizzle-orm";

const TOKEN_BYTES = 32;

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssueReferenceParams {
  referenceId: string;
  workspaceId: string;
  expiresAt: Date;
}

export async function issueReferenceToken(
  params: IssueReferenceParams,
): Promise<{ token: string; tokenId: string }> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hash(token);
  // rls: bypass — reference token issuance from inside a workspace context.
  const [row] = await db()
    .insert(schema.referenceAccessTokens)
    .values({
      tokenHash,
      referenceId: params.referenceId,
      expiresAt: params.expiresAt,
    })
    .returning({ id: schema.referenceAccessTokens.id });
  if (!row) throw new Error("failed to persist reference token");
  await audit({
    workspaceId: params.workspaceId,
    actorUserId: null,
    actorType: "system",
    action: "reference.token_issued",
    targetEntityType: "reference",
    targetEntityId: params.referenceId,
    after: { expiresAt: params.expiresAt.toISOString() },
  });
  return { token, tokenId: row.id };
}

export class ReferenceTokenInvalidError extends Error {
  constructor() {
    super("reference token is invalid, expired, or already used");
    this.name = "ReferenceTokenInvalidError";
  }
}

export interface ReferenceRedeemResult {
  referenceId: string;
  caseId: string;
  workspaceId: string;
}

export async function consumeReferenceToken(token: string): Promise<ReferenceRedeemResult> {
  // rls: bypass — pre-session redemption keyed by hash.
  const [tok] = await db()
    .update(schema.referenceAccessTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.referenceAccessTokens.tokenHash, hash(token)),
        isNull(schema.referenceAccessTokens.consumedAt),
        sql`${schema.referenceAccessTokens.expiresAt} > now()`,
      ),
    )
    .returning({
      referenceId: schema.referenceAccessTokens.referenceId,
    });
  if (!tok) throw new ReferenceTokenInvalidError();

  // rls: bypass — fetching the parent reference's case/workspace.
  const [ref] = await db()
    .select({
      caseId: schema.references.caseId,
      workspaceId: schema.references.workspaceId,
    })
    .from(schema.references)
    .where(eq(schema.references.id, tok.referenceId))
    .limit(1);
  if (!ref) throw new ReferenceTokenInvalidError();

  return { referenceId: tok.referenceId, caseId: ref.caseId, workspaceId: ref.workspaceId };
}

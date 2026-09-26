import { db, schema } from "@cred/db";
import { and, eq, isNull, sql } from "drizzle-orm";

/**
 * ensureProviderAccount — a single funnel every path that adds a
 * provider to the application funnels through.
 *
 * Responsibilities:
 *   1. Upsert users row keyed on lower(email). Marks email_verified_at
 *      when we're the one creating it — the invite-sender vouched for
 *      the address, and requiring an OTP round-trip on top of that
 *      would push providers back into the double-hop we removed.
 *   2. Upsert providers row keyed on email. Links user_id if the
 *      provider row already exists without one; otherwise inserts
 *      fresh with user_id set from the start.
 *   3. Upsert provider_workspace_grants (providerId, workspaceId)
 *      so this workspace can see the provider from day one. The
 *      first workspace to add the provider is treated as the
 *      "default agency" — for Roster Healthcare beta that IS
 *      Roster Healthcare; the same helper works for a future
 *      partner agency without conditional branching.
 *
 * Idempotent: every write is ON CONFLICT DO NOTHING / DO UPDATE, so
 * calling twice with the same email + workspace is a no-op.
 *
 * NOT the place to mint sessions or set passwords. Callers that mint
 * a session (invite redemption, direct account creation) call
 * createSession on top of the returned userId; callers that don't
 * (mint-time invite, admin add) leave the account passwordless and
 * let the provider set one via the reset or invite-redemption flow.
 */
export interface EnsureProviderAccountParams {
  email: string;
  fullName: string | null;
  workspaceId: string;
  /** Actor who created the grant — for audit. Null for system/self-service. */
  grantedByUserId?: string | null;
}

export interface EnsureProviderAccountResult {
  userId: string;
  providerId: string;
  /** True when this call created the users row (vs. found an existing one). */
  userCreated: boolean;
  /** True when this call created the providers row. */
  providerCreated: boolean;
  /** True when this call created the workspace grant. */
  grantCreated: boolean;
}

export async function ensureProviderAccount(
  params: EnsureProviderAccountParams,
): Promise<EnsureProviderAccountResult> {
  const email = params.email.trim().toLowerCase();
  const displayName = params.fullName?.trim() || null;
  const { firstName, lastName } = splitFullName(displayName);

  // rls: bypass — users is workspace-independent; pre-tenancy identity.
  const [existingUser] = await db()
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(sql`lower(${schema.users.email})`, email))
    .limit(1);

  let userId: string;
  let userCreated: boolean;
  if (existingUser) {
    userId = existingUser.id;
    userCreated = false;
  } else {
    const [inserted] = await db()
      .insert(schema.users)
      .values({
        email,
        name: displayName,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    if (!inserted) throw new Error("ensureProviderAccount: users insert failed");
    userId = inserted.id;
    userCreated = true;
  }

  // rls: bypass — providers is workspace-independent (schema §4.1).
  // Match by email since one provider can belong to multiple agencies.
  const [existingProvider] = await db()
    .select({ id: schema.providers.id, userId: schema.providers.userId })
    .from(schema.providers)
    .where(eq(sql`lower(${schema.providers.email})`, email))
    .limit(1);

  let providerId: string;
  let providerCreated: boolean;
  if (existingProvider) {
    providerId = existingProvider.id;
    providerCreated = false;
    if (existingProvider.userId !== userId) {
      // Heal the link. Also guard: only set user_id when it was NULL
      // — a mismatched, non-null user_id means two people share the
      // same email and we should not silently swap them.
      await db()
        .update(schema.providers)
        .set({ userId, updatedAt: new Date() })
        .where(and(eq(schema.providers.id, providerId), isNull(schema.providers.userId)));
    }
  } else {
    const [inserted] = await db()
      .insert(schema.providers)
      .values({
        email,
        firstName,
        lastName,
        userId,
      })
      .returning({ id: schema.providers.id });
    if (!inserted) throw new Error("ensureProviderAccount: providers insert failed");
    providerId = inserted.id;
    providerCreated = true;
  }

  // rls: bypass — grants table IS the workspace-access check.
  const insertedGrant = await db()
    .insert(schema.providerWorkspaceGrants)
    .values({
      providerId,
      workspaceId: params.workspaceId,
      grantedBy: params.grantedByUserId ?? null,
    })
    .onConflictDoNothing()
    .returning({ providerId: schema.providerWorkspaceGrants.providerId });

  return {
    userId,
    providerId,
    userCreated,
    providerCreated,
    grantCreated: insertedGrant.length > 0,
  };
}

function splitFullName(full: string | null): { firstName: string; lastName: string } {
  const trimmed = (full ?? "").trim();
  if (!trimmed) return { firstName: "Provider", lastName: "" };
  const parts = trimmed.split(/\s+/);
  const first = parts[0] ?? "Provider";
  const last = parts.slice(1).join(" ");
  return { firstName: first, lastName: last };
}

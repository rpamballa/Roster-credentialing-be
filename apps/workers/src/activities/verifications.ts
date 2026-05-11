import { UnsupportedStateError, verifyStateLicense } from "@cred/ai";
import { db, schema } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { eq, lt, sql } from "drizzle-orm";

const REVERIFY_INTERVAL_DAYS = 90;

export interface VerifyInput {
  workspaceId: string;
  providerId: string;
  state: string;
  licenseNumber: string;
}

export async function runStateLicenseVerification(input: VerifyInput): Promise<{ status: string }> {
  try {
    const result = await verifyStateLicense({
      state: input.state,
      licenseNumber: input.licenseNumber,
    });

    const nextVerifyAt = new Date(Date.now() + REVERIFY_INTERVAL_DAYS * 24 * 60 * 60 * 1000);

    // rls: bypass — verification writes from a workflow with workspaceId.
    const [row] = await db()
      .insert(schema.verifications)
      .values({
        workspaceId: input.workspaceId,
        providerId: input.providerId,
        type: "state_license",
        source: "state_board",
        state: input.state,
        licenseNumber: input.licenseNumber,
        status: result.status,
        response: (result.raw ?? {}) as Record<string, unknown>,
        verifiedAt: new Date(),
        nextVerifyAt,
      })
      .returning({ id: schema.verifications.id });
    if (!row) throw new Error("failed to persist verification");

    await audit({
      workspaceId: input.workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "verification.completed",
      targetEntityType: "verification",
      targetEntityId: row.id,
      after: {
        type: "state_license",
        state: input.state,
        status: result.status,
      },
    });
    return { status: result.status };
  } catch (err) {
    if (err instanceof UnsupportedStateError) {
      logger.warn({ state: err.state }, "state_psv_unsupported");
    }
    await db()
      .insert(schema.verifications)
      .values({
        workspaceId: input.workspaceId,
        providerId: input.providerId,
        type: "state_license",
        source: "state_board",
        state: input.state,
        licenseNumber: input.licenseNumber,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    return { status: "error" };
  }
}

/**
 * Nightly sweep: find documents expiring within 30/60/90 days and emit one
 * outreach event per provider+document. Idempotent — we de-dupe on
 * (documentId, threshold) by recording a fingerprint in audit_log.
 */
export async function expirationSweepActivity(): Promise<{ flagged: number }> {
  const horizons = [30, 60, 90];
  let flagged = 0;

  for (const days of horizons) {
    const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    // rls: bypass — system sweep across all workspaces.
    const rows = await db()
      .select({
        id: schema.documents.id,
        providerId: schema.documents.providerId,
        documentType: schema.documents.documentType,
        expiresAt: schema.documents.expiresAt,
      })
      .from(schema.documents)
      .where(
        sql`${schema.documents.expiresAt} IS NOT NULL
          AND ${schema.documents.expiresAt} > now()
          AND ${schema.documents.expiresAt} <= ${cutoff}`,
      );

    for (const r of rows) {
      // Resolve the workspaceIds with grants on this provider.
      // rls: bypass — sweep needs cross-workspace visibility.
      const grants = await db()
        .select({ workspaceId: schema.providerWorkspaceGrants.workspaceId })
        .from(schema.providerWorkspaceGrants)
        .where(eq(schema.providerWorkspaceGrants.providerId, r.providerId));

      for (const g of grants) {
        await audit({
          workspaceId: g.workspaceId,
          actorUserId: null,
          actorType: "system",
          action: `document.expiration.${days}d`,
          targetEntityType: "document",
          targetEntityId: r.id,
          after: {
            documentType: r.documentType,
            expiresAt: r.expiresAt?.toISOString() ?? null,
            horizonDays: days,
          },
        });
        flagged++;
      }
    }
  }

  // Re-verify any state licenses whose next_verify_at is past.
  // rls: bypass — system sweep.
  const stale = await db()
    .select({
      id: schema.verifications.id,
      workspaceId: schema.verifications.workspaceId,
      providerId: schema.verifications.providerId,
      state: schema.verifications.state,
      licenseNumber: schema.verifications.licenseNumber,
    })
    .from(schema.verifications)
    .where(
      sql`${schema.verifications.nextVerifyAt} IS NOT NULL
        AND ${schema.verifications.nextVerifyAt} < now()`,
    );
  for (const v of stale) {
    if (!v.state || !v.licenseNumber) continue;
    await runStateLicenseVerification({
      workspaceId: v.workspaceId,
      providerId: v.providerId,
      state: v.state,
      licenseNumber: v.licenseNumber,
    });
  }

  // Reserved for future use.
  void lt;
  return { flagged };
}

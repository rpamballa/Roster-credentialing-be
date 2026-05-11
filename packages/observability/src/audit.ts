import { schema } from "@cred/db";
import { db } from "@cred/db";
import type { ActorType } from "@cred/types/domain";
import { logger } from "./logger.js";

// PHI field allow-list keyed by target entity type. Keeping the list here
// (next to the wrapper) means a new entity must opt in to PHI-bearing fields,
// and we can statically audit which fields are considered sensitive.
export const PHI_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  provider: ["firstName", "lastName", "dob", "ssn", "ssnEncrypted", "email", "phone", "address"],
  user: ["email", "phone"],
  document: ["extractedFields", "originalFilename"],
  reference: ["email", "phone", "firstName", "lastName"],
};

const REDACTED = "<REDACTED>";

export function redactPhi(entityType: string, value: unknown): unknown {
  const phi = PHI_FIELDS[entityType];
  if (!phi || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactPhi(entityType, v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = phi.includes(k) ? REDACTED : v;
  }
  return out;
}

export interface AuditParams {
  workspaceId: string | null;
  actorUserId: string | null;
  actorType: ActorType;
  action: string;
  targetEntityType: string;
  targetEntityId: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Write one audit row. SPEC §5.5 / PROMPT §4.2.
 *
 * Every state-changing operation and every PHI read must call this. The
 * wrapper redacts known PHI fields from `before` / `after` based on
 * `targetEntityType` so callers do not manually redact.
 *
 * Audit writes intentionally bypass tenancy RLS — the wrapper itself is the
 * single privileged code path. Callers cannot influence the workspace_id
 * column except through the explicit argument.
 */
export async function audit(params: AuditParams): Promise<void> {
  const before = redactPhi(params.targetEntityType, params.before ?? null);
  const after = redactPhi(params.targetEntityType, params.after ?? null);

  try {
    // rls: bypass — audit writes are the privileged sink; workspace_id is
    // explicitly passed by the caller, not inferred from session settings.
    await db()
      .insert(schema.auditLog)
      .values({
        workspaceId: params.workspaceId,
        actorUserId: params.actorUserId,
        actorType: params.actorType,
        action: params.action,
        targetEntityType: params.targetEntityType,
        targetEntityId: params.targetEntityId,
        beforeState: before,
        afterState: after,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
        requestId: params.requestId ?? null,
      });
  } catch (err) {
    logger.error(
      { err, action: params.action, targetEntityType: params.targetEntityType },
      "audit_write_failed",
    );
    throw err;
  }

  // Warehouse sink: in dev we just log; in prod the sink is an OTel log
  // exporter or a downstream BigQuery pipeline. Either way the row above is
  // the source of truth for queryable audit.
  logger.info(
    {
      audit: true,
      action: params.action,
      targetEntityType: params.targetEntityType,
      targetEntityId: params.targetEntityId,
      workspaceId: params.workspaceId,
      actorUserId: params.actorUserId,
    },
    "audit",
  );
}

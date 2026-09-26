import { type Tx, schema } from "@cred/db";

/**
 * Record a case status transition. Called from every route handler
 * that mutates cases.status so the case detail timeline can render
 * the history without reaching back into the audit log.
 *
 * fromStatus is nullable to accommodate the initial create (case
 * opens directly at "intake" with no prior state).
 */
export interface RecordStatusEventParams {
  caseId: string;
  workspaceId: string;
  fromStatus: string | null;
  toStatus: string;
  actorUserId: string | null;
  actorType?: "user" | "system" | "agent";
  reason?: string | null;
}

export async function recordCaseStatusEvent(
  tx: Tx,
  params: RecordStatusEventParams,
): Promise<void> {
  await tx.insert(schema.caseStatusEvents).values({
    workspaceId: params.workspaceId,
    caseId: params.caseId,
    fromStatus: params.fromStatus,
    toStatus: params.toStatus,
    actorUserId: params.actorUserId,
    actorType: params.actorType ?? "user",
    reason: params.reason ?? null,
  });
}

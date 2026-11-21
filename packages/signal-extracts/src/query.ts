/**
 * Signal · extract readers for the ranker.
 * ----------------------------------------
 *
 * The ranker (WS A — `@cred/signal-match`) consumes `signal_extracts`
 * rows and multiplies their confidence by the per-workspace facet
 * weight before scoring. That consumption MUST honor consent: an
 * extract from a `revoked` conversation is considered hidden — the
 * physical row remains in the table (we keep extract rows for audit
 * so a later re-grant can re-surface them without rebuilding), but
 * `extractsForWorkspace` filters them out at read time.
 *
 * This keeps the invariant simple: extracts are hidden iff their
 * conversation's current `consent_state` says the body is hidden.
 * There is no cached "extract.revoked_at" shadow column — the
 * conversation's consent is the source of truth.
 */

import { db } from "@cred/db";
import { signalConversations, signalExtracts } from "@cred/db/schema";
import { isBodyVisible } from "@cred/db/signal";
import { and, eq, inArray } from "drizzle-orm";

export interface VisibleExtract {
  id: string;
  conversationId: string;
  facet: string;
  value: unknown;
  confidence: number | null;
  sourceSpan: Record<string, unknown> | null;
  createdAt: Date;
}

/**
 * Every extract in the workspace whose parent conversation's consent
 * does NOT hide the body. The ranker uses this list; UI surfaces
 * that want to show "here's what we learned from this provider"
 * should use it too.
 */
export async function extractsForWorkspace(workspaceId: string): Promise<VisibleExtract[]> {
  const rows = await db()
    .select({
      id: signalExtracts.id,
      conversationId: signalExtracts.conversationId,
      facet: signalExtracts.facet,
      value: signalExtracts.value,
      confidence: signalExtracts.confidence,
      sourceSpan: signalExtracts.sourceSpan,
      createdAt: signalExtracts.createdAt,
      consentState: signalConversations.consentState,
    })
    .from(signalExtracts)
    .innerJoin(signalConversations, eq(signalConversations.id, signalExtracts.conversationId))
    .where(eq(signalExtracts.workspaceId, workspaceId));
  return rows
    .filter((r) => isBodyVisible(r.consentState))
    .map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      facet: r.facet,
      value: r.value,
      confidence: r.confidence !== null ? Number(r.confidence) : null,
      sourceSpan: r.sourceSpan,
      createdAt: r.createdAt,
    }));
}

/**
 * Same filter, scoped to a specific conversation set. Lets the
 * cockpit "why did we rank this provider?" view batch-load just the
 * extracts that back a particular ranking's reasons.
 */
export async function extractsForConversations(
  workspaceId: string,
  conversationIds: readonly string[],
): Promise<VisibleExtract[]> {
  if (conversationIds.length === 0) return [];
  const rows = await db()
    .select({
      id: signalExtracts.id,
      conversationId: signalExtracts.conversationId,
      facet: signalExtracts.facet,
      value: signalExtracts.value,
      confidence: signalExtracts.confidence,
      sourceSpan: signalExtracts.sourceSpan,
      createdAt: signalExtracts.createdAt,
      consentState: signalConversations.consentState,
    })
    .from(signalExtracts)
    .innerJoin(signalConversations, eq(signalConversations.id, signalExtracts.conversationId))
    .where(
      and(
        eq(signalExtracts.workspaceId, workspaceId),
        inArray(signalExtracts.conversationId, conversationIds as string[]),
      ),
    );
  return rows
    .filter((r) => isBodyVisible(r.consentState))
    .map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      facet: r.facet,
      value: r.value,
      confidence: r.confidence !== null ? Number(r.confidence) : null,
      sourceSpan: r.sourceSpan,
      createdAt: r.createdAt,
    }));
}

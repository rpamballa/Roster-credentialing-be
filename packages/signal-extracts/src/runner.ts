/**
 * Signal · extracts runner
 * ------------------------
 *
 * Iterates `signal_conversations` for a workspace, runs the pure
 * extractor (`./extract.ts`) against each visible body, and upserts
 * matches into `signal_extracts`.
 *
 * Visibility is enforced here, not on the ranker side. Two guardrails:
 *
 *   1. We scope by `workspaceId` through the tenant DAL on both ends
 *      (read conversations, write extracts), so cross-tenant leaks
 *      can't go through this entry point.
 *
 *   2. We filter out `consent_state = 'revoked'` and any state whose
 *      body is not visible (see `isBodyVisible` in @cred/db/signal).
 *      A conversation with no body (null) or one whose consent hides
 *      the body produces zero extracts, even if the extractor itself
 *      is called with an empty string.
 *
 * Idempotency: the migration adds a partial unique index on
 * `(conversation_id, facet, (source_span->>'start')::int)` for rows
 * whose source_span is present, so a second run against unchanged
 * conversation bodies cannot insert a duplicate. We use `ON CONFLICT
 * DO NOTHING` so idempotency is guaranteed at the DB layer, not just
 * at the application layer.
 */

import { db } from "@cred/db";
import { signalConversations, signalExtracts } from "@cred/db/schema";
import { isBodyVisible } from "@cred/db/signal";
import { and, eq, inArray } from "drizzle-orm";
import { type Extract, extract } from "./extract.js";

export interface RunExtractsOptions {
  workspaceId: string;
  /**
   * When present, only process these conversation ids. Useful for the
   * post-ingest fan-out in `@cred/signal-ingest` where the runner has
   * the fresh id set in hand; omitted, processes every conversation
   * for the workspace that hasn't been extract-enriched yet.
   */
  conversationIds?: readonly string[];
}

export interface RunExtractsSummary {
  conversationsProcessed: number;
  extractsInserted: number;
  extractsSkipped: number;
  /** Conversation ids skipped because consent hides the body. */
  bodiesHidden: number;
}

/**
 * Run the extractor over every workspace conversation. Returns a
 * summary for the caller to fold into its own ingest-run summary.
 */
export async function runExtracts(opts: RunExtractsOptions): Promise<RunExtractsSummary> {
  const { workspaceId } = opts;
  const summary: RunExtractsSummary = {
    conversationsProcessed: 0,
    extractsInserted: 0,
    extractsSkipped: 0,
    bodiesHidden: 0,
  };

  const rows = await db()
    .select({
      id: signalConversations.id,
      consentState: signalConversations.consentState,
      body: signalConversations.body,
    })
    .from(signalConversations)
    .where(
      opts.conversationIds && opts.conversationIds.length > 0
        ? and(
            eq(signalConversations.workspaceId, workspaceId),
            inArray(signalConversations.id, opts.conversationIds as string[]),
          )
        : eq(signalConversations.workspaceId, workspaceId),
    );

  for (const row of rows) {
    summary.conversationsProcessed += 1;
    if (!isBodyVisible(row.consentState)) {
      summary.bodiesHidden += 1;
      continue;
    }
    const body = row.body ?? "";
    if (!body) continue;
    const found = extract(body);
    for (const ex of found) {
      const inserted = await upsertExtract(workspaceId, row.id, ex);
      if (inserted) summary.extractsInserted += 1;
      else summary.extractsSkipped += 1;
    }
  }

  return summary;
}

/**
 * Upsert one extract row. Returns `true` when a new row was inserted,
 * `false` when the unique index absorbed it. We use `ON CONFLICT DO
 * NOTHING` on the partial unique index the migration ships so the
 * check is atomic — callers can't see a half-written state and
 * concurrent runners can't race into duplicates.
 */
async function upsertExtract(
  workspaceId: string,
  conversationId: string,
  ex: Extract,
): Promise<boolean> {
  // Store confidence as a numeric string — Drizzle's numeric column
  // takes strings for exact representation (precision/scale fixed).
  const confidenceStr = ex.confidence.toFixed(4);
  // `ON CONFLICT DO NOTHING` with no target absorbs any unique or
  // exclusion violation on the table. The partial unique index the
  // migration ships is on an expression tuple
  // ((conversation_id, facet, (source_span->>'start')::int)) that
  // Drizzle can't model via a typed `target`, so we rely on the
  // untargeted form — Postgres picks whichever constraint fires.
  const result = await db()
    .insert(signalExtracts)
    .values({
      workspaceId,
      conversationId,
      facet: ex.facet,
      value: ex.value,
      confidence: confidenceStr,
      sourceSpan: { start: ex.sourceSpan.start, end: ex.sourceSpan.end },
    })
    .onConflictDoNothing()
    .returning({ id: signalExtracts.id });
  return result.length > 0;
}

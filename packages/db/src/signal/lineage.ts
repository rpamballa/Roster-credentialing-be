import { and, eq, sql } from "drizzle-orm";
import { type Database, db } from "../client.js";
import {
  type SignalSourceLineageRow,
  signalSourceLineage,
} from "../schema/signal/sourceLineage.js";
import type { Tx } from "../tenancy.js";

/**
 * Executor type accepted by Signal helpers: either the root Drizzle
 * `db()` client or a transaction scope returned by `db().transaction`.
 * Both expose the same query-builder surface this helper needs.
 */
export type SignalExecutor = Database | Tx;

export interface RecordLineageArgs {
  workspaceId: string;
  canonicalTable: string;
  canonicalId: string;
  externalSystem: string;
  externalId: string;
}

/**
 * Upsert a source-lineage row.
 *
 * Idempotent on the (`workspace_id`, `canonical_table`,
 * `canonical_id`, `external_system`, `external_id`) tuple:
 *
 *   - First call with a given tuple: INSERT, returns the new row.
 *   - Any subsequent call with the same tuple: UPDATE
 *     `last_synced` to now(), returns the updated row.
 *
 * Signal doesn't own the lineage schema — it is shared across
 * workstreams, so this helper is the single sanctioned write path.
 */
export async function recordLineage(
  executor: SignalExecutor,
  args: RecordLineageArgs,
): Promise<SignalSourceLineageRow> {
  const rows = await executor
    .insert(signalSourceLineage)
    .values({
      workspaceId: args.workspaceId,
      canonicalTable: args.canonicalTable,
      canonicalId: args.canonicalId,
      externalSystem: args.externalSystem,
      externalId: args.externalId,
    })
    .onConflictDoUpdate({
      target: [
        signalSourceLineage.workspaceId,
        signalSourceLineage.canonicalTable,
        signalSourceLineage.canonicalId,
        signalSourceLineage.externalSystem,
        signalSourceLineage.externalId,
      ],
      set: { lastSynced: sql`now()` },
    })
    .returning();

  const row = rows[0];
  if (!row) {
    // onConflictDoUpdate always returns one row; this guard is
    // defensive for unexpected driver behaviour under RLS.
    throw new Error("recordLineage: no row returned from upsert");
  }
  return row;
}

/**
 * Convenience: fetch all lineage rows for a canonical row, scoped
 * to the current workspace. Useful for tests and for the explain-
 * a-ranking endpoint.
 */
export async function lineageForCanonical(
  executor: SignalExecutor,
  args: { workspaceId: string; canonicalTable: string; canonicalId: string },
): Promise<SignalSourceLineageRow[]> {
  return executor
    .select()
    .from(signalSourceLineage)
    .where(
      and(
        eq(signalSourceLineage.workspaceId, args.workspaceId),
        eq(signalSourceLineage.canonicalTable, args.canonicalTable),
        eq(signalSourceLineage.canonicalId, args.canonicalId),
      ),
    );
}

/** Test seam: callers that already have a Database can call `recordLineage(db(), …)`. */
export function defaultExecutor(): SignalExecutor {
  return db();
}

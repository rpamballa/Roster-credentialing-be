import { type SQL, and, eq } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "../client.js";
import {
  signalConversations,
  signalCredentials,
  signalExtracts,
  signalJobs,
  signalOverrides,
  signalProviders,
  signalRankings,
  signalSourceLineage,
  signalWeights,
} from "../schema/signal/index.js";
import type { SignalExecutor } from "./lineage.js";

/**
 * Signal's tenant boundary is `workspace_id`. Every table in the
 * `signal_*` family carries that column; a query that forgets to
 * filter by it will return rows from other agencies. This helper
 * is the sanctioned DAL — it returns a scoped query object whose
 * methods embed the `workspace_id = ?` predicate for you, and
 * whose insert refuses any row whose `workspaceId` doesn't match
 * the scope.
 *
 * Typing note: the Signal tables don't share RLS with the
 * credentialing `providers` / `cases` / `documents` tables (those
 * use the `app.current_workspace_id` setting + `FORCE ROW LEVEL
 * SECURITY`). We leave RLS off the Signal tables for v0 — the
 * ranker needs to compare rows across a single workspace in bulk,
 * and layering RLS on top of a helper that already filters by
 * workspace would double the enforcement. This DAL is the one
 * enforcement point.
 *
 * Example:
 *   const scoped = withWorkspace(workspaceId);
 *   const jobs   = await scoped.jobs.list();
 *   const [j]    = await scoped.jobs.insert({ specialty: "anesth", ... });
 *   //                                   ^^ workspaceId is auto-stamped
 */
export interface ScopedQuery<
  TTable extends PgTable & { workspaceId: PgColumn },
  TRow,
  TInsert extends { workspaceId?: string | undefined },
> {
  /** Run a SELECT * filtered by workspace. */
  list(where?: SQL): Promise<TRow[]>;
  /** Fetch one row by id (also workspace-filtered). */
  findById(id: string): Promise<TRow | undefined>;
  /** Insert one or many rows; any explicit `workspaceId` must match the scope. */
  insert(row: Omit<TInsert, "workspaceId"> | Omit<TInsert, "workspaceId">[]): Promise<TRow[]>;
  /** The underlying table — for ad-hoc joins. Prefer named methods over this. */
  table: TTable;
}

function makeScoped<
  TTable extends PgTable & { workspaceId: PgColumn; id: PgColumn },
  TRow extends Record<string, unknown>,
  TInsert extends { workspaceId?: string | undefined; id?: string | undefined },
>(
  executor: SignalExecutor,
  workspaceId: string,
  table: TTable,
): ScopedQuery<TTable, TRow, TInsert> {
  return {
    table,
    async list(extra?: SQL): Promise<TRow[]> {
      const predicate = extra
        ? and(eq(table.workspaceId, workspaceId), extra)
        : eq(table.workspaceId, workspaceId);
      return executor.select().from(table).where(predicate) as unknown as Promise<TRow[]>;
    },
    async findById(id: string): Promise<TRow | undefined> {
      const rows = (await executor
        .select()
        .from(table)
        .where(and(eq(table.workspaceId, workspaceId), eq(table.id, id)))
        .limit(1)) as unknown as TRow[];
      return rows[0];
    },
    async insert(
      row: Omit<TInsert, "workspaceId"> | Omit<TInsert, "workspaceId">[],
    ): Promise<TRow[]> {
      const rows = Array.isArray(row) ? row : [row];
      const stamped = rows.map((r) => {
        const explicit = (r as Partial<TInsert>).workspaceId;
        if (explicit !== undefined && explicit !== workspaceId) {
          // Fail-fast: a caller passing someone else's workspaceId
          // into our scoped helper is a programming error.
          throw new Error(
            `withWorkspace(${workspaceId}): refusing insert with workspaceId=${explicit}`,
          );
        }
        return { ...r, workspaceId } as TInsert;
      });
      // Drizzle's `.values()` type is a deep generic derived from the
      // concrete table's column map; our generic view of it is a
      // narrower superset, so we hand it off through `unknown` after
      // the scope's workspaceId has been stamped in.
      return executor
        .insert(table)
        .values(stamped as unknown as TTable["$inferInsert"])
        .returning() as unknown as Promise<TRow[]>;
    },
  };
}

/**
 * Validate a workspaceId shape at the DAL boundary — the same
 * convention `withTenancy` uses in the credentialing stack.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SignalScoped {
  workspaceId: string;
  providers: ScopedQuery<
    typeof signalProviders,
    typeof signalProviders.$inferSelect,
    typeof signalProviders.$inferInsert
  >;
  jobs: ScopedQuery<
    typeof signalJobs,
    typeof signalJobs.$inferSelect,
    typeof signalJobs.$inferInsert
  >;
  credentials: ScopedQuery<
    typeof signalCredentials,
    typeof signalCredentials.$inferSelect,
    typeof signalCredentials.$inferInsert
  >;
  conversations: ScopedQuery<
    typeof signalConversations,
    typeof signalConversations.$inferSelect,
    typeof signalConversations.$inferInsert
  >;
  extracts: ScopedQuery<
    typeof signalExtracts,
    typeof signalExtracts.$inferSelect,
    typeof signalExtracts.$inferInsert
  >;
  rankings: ScopedQuery<
    typeof signalRankings,
    typeof signalRankings.$inferSelect,
    typeof signalRankings.$inferInsert
  >;
  overrides: ScopedQuery<
    typeof signalOverrides,
    typeof signalOverrides.$inferSelect,
    typeof signalOverrides.$inferInsert
  >;
  sourceLineage: ScopedQuery<
    typeof signalSourceLineage,
    typeof signalSourceLineage.$inferSelect,
    typeof signalSourceLineage.$inferInsert
  >;
  weights: ScopedQuery<
    typeof signalWeights,
    typeof signalWeights.$inferSelect,
    typeof signalWeights.$inferInsert
  >;
}

/**
 * Open a workspace-scoped query helper. All methods auto-filter
 * their SELECTs and stamp the workspace_id on INSERTs.
 *
 * Pass a transaction (`tx`) when calling from inside `withTenancy`
 * or a manual `db().transaction(...)`; otherwise defaults to the
 * root Drizzle client.
 */
export function withWorkspace(workspaceId: string, executor?: SignalExecutor): SignalScoped {
  if (!UUID_RE.test(workspaceId)) {
    throw new Error(`withWorkspace: workspaceId is not a valid UUID (${workspaceId})`);
  }
  const exec = executor ?? db();
  return {
    workspaceId,
    providers: makeScoped(exec, workspaceId, signalProviders),
    jobs: makeScoped(exec, workspaceId, signalJobs),
    credentials: makeScoped(exec, workspaceId, signalCredentials),
    conversations: makeScoped(exec, workspaceId, signalConversations),
    extracts: makeScoped(exec, workspaceId, signalExtracts),
    rankings: makeScoped(exec, workspaceId, signalRankings),
    overrides: makeScoped(exec, workspaceId, signalOverrides),
    sourceLineage: makeScoped(exec, workspaceId, signalSourceLineage),
    weights: makeScoped(exec, workspaceId, signalWeights),
  };
}

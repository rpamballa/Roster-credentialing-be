import { type SQL, and, desc, eq, isNull, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "../client.js";
import {
  signalAdapterCredentials,
  signalConversations,
  signalCredentials,
  signalEvalRuns,
  signalExtracts,
  signalJobs,
  signalKnowledgeChunks,
  signalKnowledgeDocuments,
  signalOnboardingGaps,
  signalOverrides,
  signalProviders,
  signalRankings,
  signalSourceLineage,
  signalWeights,
  signalWorkspaceConfig,
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
 * Append-only workspace config helper.
 *
 * Writes always INSERT; reads pick the latest row per (scope, key).
 * `history()` returns the full timeline for audit / rollback. This is
 * deliberately NOT a plain `ScopedQuery` — the append-only semantics
 * are the point.
 */
export interface SignalWorkspaceConfigScoped {
  get(scope: string, key: string): Promise<unknown | undefined>;
  getRow(
    scope: string,
    key: string,
  ): Promise<typeof signalWorkspaceConfig.$inferSelect | undefined>;
  listScope(scope: string): Promise<Array<{ key: string; value: unknown; createdAt: Date }>>;
  put(args: {
    scope: string;
    key: string;
    value: unknown;
    createdBy?: string | null;
  }): Promise<typeof signalWorkspaceConfig.$inferSelect>;
  history(
    scope: string,
    key: string,
  ): Promise<Array<typeof signalWorkspaceConfig.$inferSelect>>;
}

function makeWorkspaceConfigScoped(
  executor: SignalExecutor,
  workspaceId: string,
): SignalWorkspaceConfigScoped {
  const t = signalWorkspaceConfig;
  return {
    async get(scope, key) {
      const [row] = (await executor
        .select({ value: t.value })
        .from(t)
        .where(and(eq(t.workspaceId, workspaceId), eq(t.scope, scope), eq(t.key, key)))
        .orderBy(desc(t.createdAt))
        .limit(1)) as Array<{ value: unknown }>;
      return row?.value;
    },
    async getRow(scope, key) {
      const [row] = (await executor
        .select()
        .from(t)
        .where(and(eq(t.workspaceId, workspaceId), eq(t.scope, scope), eq(t.key, key)))
        .orderBy(desc(t.createdAt))
        .limit(1)) as Array<typeof t.$inferSelect>;
      return row;
    },
    async listScope(scope) {
      // DISTINCT ON (key) + ORDER BY key, created_at DESC gives the
      // latest value per key in one round-trip.
      const result = (await executor.execute(sql`
          SELECT DISTINCT ON (key) key, value, created_at
          FROM ${t}
          WHERE workspace_id = ${workspaceId} AND scope = ${scope}
          ORDER BY key, created_at DESC
        `)) as unknown;
      const list = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
      const out: Array<{ key: string; value: unknown; createdAt: Date }> = [];
      for (const r of list as Array<Record<string, unknown>>) {
        out.push({
          key: r.key as string,
          value: r.value,
          createdAt: (r.created_at ?? r.createdAt) as Date,
        });
      }
      return out;
    },
    async put({ scope, key, value, createdBy }) {
      const [row] = (await executor
        .insert(t)
        .values({
          workspaceId,
          scope,
          key,
          value: value as never,
          createdBy: createdBy ?? null,
        })
        .returning()) as Array<typeof t.$inferSelect>;
      return row!;
    },
    async history(scope, key) {
      return (await executor
        .select()
        .from(t)
        .where(and(eq(t.workspaceId, workspaceId), eq(t.scope, scope), eq(t.key, key)))
        .orderBy(desc(t.createdAt))) as Array<typeof t.$inferSelect>;
    },
  };
}

/**
 * Knowledge-document helper. Standard CRUD, but `list()` and
 * `findById()` auto-filter `deleted_at IS NULL`. Hard deletes are
 * not exposed — `softDelete()` is the one write path.
 */
export interface SignalKnowledgeDocumentsScoped {
  list(): Promise<Array<typeof signalKnowledgeDocuments.$inferSelect>>;
  findById(id: string): Promise<typeof signalKnowledgeDocuments.$inferSelect | undefined>;
  insert(
    row: Omit<typeof signalKnowledgeDocuments.$inferInsert, "workspaceId">,
  ): Promise<typeof signalKnowledgeDocuments.$inferSelect>;
  softDelete(id: string): Promise<boolean>;
  table: typeof signalKnowledgeDocuments;
}

function makeKnowledgeDocumentsScoped(
  executor: SignalExecutor,
  workspaceId: string,
): SignalKnowledgeDocumentsScoped {
  const t = signalKnowledgeDocuments;
  return {
    table: t,
    async list() {
      return (await executor
        .select()
        .from(t)
        .where(and(eq(t.workspaceId, workspaceId), isNull(t.deletedAt)))
        .orderBy(desc(t.createdAt))) as Array<typeof t.$inferSelect>;
    },
    async findById(id) {
      const [row] = (await executor
        .select()
        .from(t)
        .where(and(eq(t.workspaceId, workspaceId), eq(t.id, id), isNull(t.deletedAt)))
        .limit(1)) as Array<typeof t.$inferSelect>;
      return row;
    },
    async insert(row) {
      const [created] = (await executor
        .insert(t)
        .values({ ...row, workspaceId })
        .returning()) as Array<typeof t.$inferSelect>;
      return created!;
    },
    async softDelete(id) {
      const updated = (await executor
        .update(t)
        .set({ deletedAt: new Date() })
        .where(and(eq(t.workspaceId, workspaceId), eq(t.id, id), isNull(t.deletedAt)))
        .returning({ id: t.id })) as Array<{ id: string }>;
      return updated.length > 0;
    },
  };
}

/**
 * Knowledge-chunk helper. Writes via `insertMany`; reads scoped to
 * a document. Vector search is exposed by `@cred/signal-knowledge`,
 * which also threads the workspace predicate through the WHERE
 * clause.
 */
export interface SignalKnowledgeChunksScoped {
  listByDocument(documentId: string): Promise<Array<typeof signalKnowledgeChunks.$inferSelect>>;
  insertMany(
    rows: Array<Omit<typeof signalKnowledgeChunks.$inferInsert, "workspaceId">>,
  ): Promise<Array<typeof signalKnowledgeChunks.$inferSelect>>;
  deleteByDocument(documentId: string): Promise<number>;
  table: typeof signalKnowledgeChunks;
}

function makeKnowledgeChunksScoped(
  executor: SignalExecutor,
  workspaceId: string,
): SignalKnowledgeChunksScoped {
  const t = signalKnowledgeChunks;
  return {
    table: t,
    async listByDocument(documentId) {
      return (await executor
        .select()
        .from(t)
        .where(and(eq(t.workspaceId, workspaceId), eq(t.documentId, documentId)))) as Array<
        typeof t.$inferSelect
      >;
    },
    async insertMany(rows) {
      if (rows.length === 0) return [];
      const stamped = rows.map((r) => ({ ...r, workspaceId }));
      return (await executor
        .insert(t)
        .values(stamped as never)
        .returning()) as Array<typeof t.$inferSelect>;
    },
    async deleteByDocument(documentId) {
      const deleted = (await executor
        .delete(t)
        .where(and(eq(t.workspaceId, workspaceId), eq(t.documentId, documentId)))
        .returning({ id: t.id })) as Array<{ id: string }>;
      return deleted.length;
    },
  };
}

/**
 * Adapter credentials helper. Writes use `ON CONFLICT (workspace_id,
 * adapter) DO UPDATE` to bump `payload_version` and `rotated_at`.
 * Reads return metadata only (no ciphertext over HTTP); `getFull()`
 * is reserved for in-process callers (the ingestion runner).
 */
export interface SignalAdapterCredentialsScoped {
  listMetadata(): Promise<
    Array<{ adapter: string; payloadVersion: number; rotatedAt: Date; createdAt: Date }>
  >;
  getMetadata(
    adapter: string,
  ): Promise<
    | { adapter: string; payloadVersion: number; rotatedAt: Date; createdAt: Date }
    | undefined
  >;
  getFull(adapter: string): Promise<typeof signalAdapterCredentials.$inferSelect | undefined>;
  upsert(args: {
    adapter: string;
    encryptedPayload: Buffer;
  }): Promise<typeof signalAdapterCredentials.$inferSelect>;
  remove(adapter: string): Promise<boolean>;
  table: typeof signalAdapterCredentials;
}

function makeAdapterCredentialsScoped(
  executor: SignalExecutor,
  workspaceId: string,
): SignalAdapterCredentialsScoped {
  const t = signalAdapterCredentials;
  return {
    table: t,
    async listMetadata() {
      return (await executor
        .select({
          adapter: t.adapter,
          payloadVersion: t.payloadVersion,
          rotatedAt: t.rotatedAt,
          createdAt: t.createdAt,
        })
        .from(t)
        .where(eq(t.workspaceId, workspaceId))) as Array<{
        adapter: string;
        payloadVersion: number;
        rotatedAt: Date;
        createdAt: Date;
      }>;
    },
    async getMetadata(adapter) {
      const [row] = (await executor
        .select({
          adapter: t.adapter,
          payloadVersion: t.payloadVersion,
          rotatedAt: t.rotatedAt,
          createdAt: t.createdAt,
        })
        .from(t)
        .where(and(eq(t.workspaceId, workspaceId), eq(t.adapter, adapter)))
        .limit(1)) as Array<{
        adapter: string;
        payloadVersion: number;
        rotatedAt: Date;
        createdAt: Date;
      }>;
      return row;
    },
    async getFull(adapter) {
      const [row] = (await executor
        .select()
        .from(t)
        .where(and(eq(t.workspaceId, workspaceId), eq(t.adapter, adapter)))
        .limit(1)) as Array<typeof t.$inferSelect>;
      return row;
    },
    async upsert({ adapter, encryptedPayload }) {
      const [row] = (await executor
        .insert(t)
        .values({ workspaceId, adapter, encryptedPayload })
        .onConflictDoUpdate({
          target: [t.workspaceId, t.adapter],
          set: {
            encryptedPayload,
            payloadVersion: sql`${t.payloadVersion} + 1`,
            rotatedAt: new Date(),
          },
        })
        .returning()) as Array<typeof t.$inferSelect>;
      return row!;
    },
    async remove(adapter) {
      const deleted = (await executor
        .delete(t)
        .where(and(eq(t.workspaceId, workspaceId), eq(t.adapter, adapter)))
        .returning({ id: t.id })) as Array<{ id: string }>;
      return deleted.length > 0;
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
  evalRuns: ScopedQuery<
    typeof signalEvalRuns,
    typeof signalEvalRuns.$inferSelect,
    typeof signalEvalRuns.$inferInsert
  >;
  config: SignalWorkspaceConfigScoped;
  knowledgeDocuments: SignalKnowledgeDocumentsScoped;
  knowledgeChunks: SignalKnowledgeChunksScoped;
  adapterCredentials: SignalAdapterCredentialsScoped;
  onboardingGaps: ScopedQuery<
    typeof signalOnboardingGaps,
    typeof signalOnboardingGaps.$inferSelect,
    typeof signalOnboardingGaps.$inferInsert
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
    evalRuns: makeScoped(exec, workspaceId, signalEvalRuns),
    config: makeWorkspaceConfigScoped(exec, workspaceId),
    knowledgeDocuments: makeKnowledgeDocumentsScoped(exec, workspaceId),
    knowledgeChunks: makeKnowledgeChunksScoped(exec, workspaceId),
    adapterCredentials: makeAdapterCredentialsScoped(exec, workspaceId),
    onboardingGaps: makeScoped(exec, workspaceId, signalOnboardingGaps),
  };
}

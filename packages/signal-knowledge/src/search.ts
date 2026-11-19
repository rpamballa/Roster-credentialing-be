// Workspace-scoped vector similarity search over the knowledge base.
//
// The workspace predicate is non-negotiable: cross-tenant leakage is
// the whole threat this product line has to defend against. We
// enforce it two ways:
//   1. Require a workspaceId arg (no "list all") and refuse a
//      malformed one at the DAL boundary.
//   2. Thread `WHERE workspace_id = $1` into the SQL alongside the
//      ORDER BY on `<=>`. Postgres combines the predicate with the
//      IVFFlat index scan, so cross-workspace chunks never enter the
//      top-N even if they would be semantically closer.
//
// The test suite in ../test/search.test.ts covers both: seeding
// workspace A with content identical to workspace B's and asserting
// that a search in A never returns B's chunks.

import { db, schema } from "@cred/db";
import { withWorkspace } from "@cred/db/signal";
import { sql } from "drizzle-orm";
import { embedQuery } from "./embedding.js";

export interface KnowledgeSearchHit {
  documentId: string;
  documentTitle: string;
  chunkId: string;
  chunkIndex: number;
  chunkText: string;
  /** Cosine distance (0 = identical, 2 = opposite). Lower is better. */
  distance: number;
  /** Cosine similarity: 1 - distance. Higher is better. [-1, 1]. */
  score: number;
}

export interface KnowledgeSearchArgs {
  workspaceId: string;
  query: string;
  limit?: number;
  /** Max cosine distance to return a hit — defaults to 2 (everything). */
  maxDistance?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Workspace-scoped nearest-neighbour search over knowledge chunks.
 *
 * Returns the top-N chunks closest to `query` as measured by cosine
 * distance (pgvector's `<=>` operator with `vector_cosine_ops`). A
 * soft-deleted document's chunks are filtered out via the join.
 *
 * Throws if `workspaceId` is not a valid UUID — the DAL's own guard.
 */
export async function searchKnowledge(
  args: KnowledgeSearchArgs,
): Promise<KnowledgeSearchHit[]> {
  if (!UUID_RE.test(args.workspaceId)) {
    throw new Error(`searchKnowledge: workspaceId is not a valid UUID (${args.workspaceId})`);
  }
  // Opens the scoped helper to inherit the workspaceId guard/shape
  // even when we need raw SQL for the vector operator below.
  withWorkspace(args.workspaceId);

  const limit = Math.min(Math.max(args.limit ?? 5, 1), 50);
  const maxDistance = args.maxDistance ?? 2;
  const vector = await embedQuery(args.query);
  const vectorLiteral = `[${vector.join(",")}]`;

  // Raw SQL — drizzle doesn't have a first-class pgvector operator
  // today. The parameters are bound; the workspace_id filter is in
  // the WHERE so the planner combines it with the IVFFlat scan.
  const rows = (await db().execute(sql`
      SELECT
        c.id            AS chunk_id,
        c.document_id   AS document_id,
        c.chunk_index   AS chunk_index,
        c.chunk_text    AS chunk_text,
        d.title         AS document_title,
        (c.embedding <=> ${vectorLiteral}::vector) AS distance
      FROM ${schema.signalKnowledgeChunks} c
      INNER JOIN ${schema.signalKnowledgeDocuments} d
        ON d.id = c.document_id
      WHERE c.workspace_id = ${args.workspaceId}
        AND d.workspace_id = ${args.workspaceId}
        AND d.deleted_at IS NULL
        AND (c.embedding <=> ${vectorLiteral}::vector) <= ${maxDistance}
      ORDER BY c.embedding <=> ${vectorLiteral}::vector ASC
      LIMIT ${limit}
    `)) as unknown;

  const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
  const hits: KnowledgeSearchHit[] = [];
  for (const r of list as Array<Record<string, unknown>>) {
    const distance = Number(r.distance);
    hits.push({
      documentId: r.document_id as string,
      documentTitle: r.document_title as string,
      chunkId: r.chunk_id as string,
      chunkIndex: Number(r.chunk_index),
      chunkText: r.chunk_text as string,
      distance,
      score: 1 - distance,
    });
  }
  return hits;
}

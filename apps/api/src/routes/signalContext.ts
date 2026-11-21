// Roster Signal · agency-local context storage HTTP surface.
//
// This file hangs off the same kill-switch and session middleware as
// `routes/signal.ts`; it has its own `requireSignalTenancy` guard so
// a mis-order in `app.ts` can't let anonymous requests through.
//
// Four sub-surfaces live here:
//   1. /v1/signal/config/**           — append-only key/value store
//   2. /v1/signal/knowledge/**        — markdown corpus + vector search
//   3. /v1/signal/credentials/**      — encrypted adapter creds
//                                      (metadata-only reads)
//   4. /v1/signal/gaps/**             — onboarding gap log
//
// All are workspace-scoped at the DAL and auto-filter by the
// tenancy middleware's resolved workspaceId.

import { db, schema } from "@cred/db";
import { withWorkspace } from "@cred/db/signal";
import { logger } from "@cred/observability";
import {
  chunkMarkdown,
  decryptCredential,
  embedChunks,
  encryptCredential,
  searchKnowledge,
} from "@cred/signal-knowledge";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { ApiBindings } from "../types.js";

// Re-declare the same tenancy variable the `signal.ts` router uses,
// so this file can share the hono context var map without importing
// private types.
declare module "hono" {
  interface ContextVariableMap {
    signalTenancy: { workspaceId: string };
  }
}

function unauthorized(c: Context<ApiBindings>): Response {
  return c.json(
    { type: "about:blank", title: "Unauthorized", status: 401, instance: c.var.requestId },
    401,
  );
}

function forbidden(c: Context<ApiBindings>, detail: string): Response {
  return c.json(
    { type: "about:blank", title: "Forbidden", status: 403, detail, instance: c.var.requestId },
    403,
  );
}

function notFound(c: Context<ApiBindings>): Response {
  return c.json(
    { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
    404,
  );
}

async function requireSignalTenancy(
  c: Context<ApiBindings>,
  next: () => Promise<void>,
): Promise<Response | undefined> {
  const auth = c.var.auth;
  if (!auth) return unauthorized(c);
  let workspaceId: string | undefined;
  if (auth.session.kind === "staff") {
    workspaceId = auth.session.activeWorkspaceId ?? undefined;
  } else if (auth.session.kind === "provider") {
    workspaceId = auth.session.caseWorkspaceId ?? undefined;
  }
  if (!workspaceId) return forbidden(c, "No workspace on session.");
  // Only staff sessions should be able to touch context storage —
  // provider sessions access only their own case's data and have no
  // business editing playbooks, credentials, or gaps.
  if (auth.session.kind !== "staff") {
    return forbidden(c, "Signal context storage is staff-only.");
  }
  c.set("signalTenancy", { workspaceId });
  await next();
  return undefined;
}

function actorUserId(c: Context<ApiBindings>): string | null {
  const auth = c.var.auth;
  return auth?.session.kind === "staff" ? auth.session.userId : null;
}

export const signalContextRoutes = new Hono<ApiBindings>();
signalContextRoutes.use("/v1/signal/config/*", requireSignalTenancy);
signalContextRoutes.use("/v1/signal/config", requireSignalTenancy);
signalContextRoutes.use("/v1/signal/knowledge/*", requireSignalTenancy);
signalContextRoutes.use("/v1/signal/knowledge", requireSignalTenancy);
signalContextRoutes.use("/v1/signal/credentials/*", requireSignalTenancy);
signalContextRoutes.use("/v1/signal/credentials", requireSignalTenancy);
signalContextRoutes.use("/v1/signal/gaps/*", requireSignalTenancy);
signalContextRoutes.use("/v1/signal/gaps", requireSignalTenancy);

// ─── CONFIG ───────────────────────────────────────────────────────────────

const ScopeKeySegment = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/, "scope/key must be [A-Za-z0-9._:-]+");

signalContextRoutes.get(
  "/v1/signal/config",
  zValidator("query", z.object({ scope: ScopeKeySegment })),
  async (c) => {
    const { workspaceId } = c.var.signalTenancy;
    const { scope } = c.req.valid("query");
    const rows = await withWorkspace(workspaceId).config.listScope(scope);
    return c.json({ scope, entries: rows });
  },
);

signalContextRoutes.get("/v1/signal/config/:scope/:key", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const scope = ScopeKeySegment.safeParse(c.req.param("scope"));
  const key = ScopeKeySegment.safeParse(c.req.param("key"));
  if (!scope.success || !key.success) return notFound(c);
  const row = await withWorkspace(workspaceId).config.getRow(scope.data, key.data);
  if (!row) return notFound(c);
  return c.json({
    scope: row.scope,
    key: row.key,
    value: row.value,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
  });
});

signalContextRoutes.put(
  "/v1/signal/config/:scope/:key",
  zValidator(
    "json",
    z.object({ value: z.unknown() }),
  ),
  async (c) => {
    const { workspaceId } = c.var.signalTenancy;
    const scope = ScopeKeySegment.safeParse(c.req.param("scope"));
    const key = ScopeKeySegment.safeParse(c.req.param("key"));
    if (!scope.success || !key.success) {
      return c.json(
        {
          type: "about:blank",
          title: "Bad Request",
          status: 400,
          detail: "scope/key must match [A-Za-z0-9._:-]+",
          instance: c.var.requestId,
        },
        400,
      );
    }
    const { value } = c.req.valid("json");
    const row = await withWorkspace(workspaceId).config.put({
      scope: scope.data,
      key: key.data,
      value,
      createdBy: actorUserId(c),
    });
    return c.json(
      {
        scope: row.scope,
        key: row.key,
        value: row.value,
        createdAt: row.createdAt.toISOString(),
        createdBy: row.createdBy,
      },
      201,
    );
  },
);

signalContextRoutes.get("/v1/signal/config/:scope/:key/history", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const scope = ScopeKeySegment.safeParse(c.req.param("scope"));
  const key = ScopeKeySegment.safeParse(c.req.param("key"));
  if (!scope.success || !key.success) return notFound(c);
  const rows = await withWorkspace(workspaceId).config.history(scope.data, key.data);
  return c.json({
    scope: scope.data,
    key: key.data,
    history: rows.map((r) => ({
      value: r.value,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy,
    })),
  });
});

// ─── KNOWLEDGE ────────────────────────────────────────────────────────────

const KnowledgeUpload = z.object({
  title: z.string().trim().min(1).max(500),
  bodyMarkdown: z.string().min(1).max(500_000),
  tags: z.array(z.string().trim().min(1).max(60)).max(32).optional(),
});

signalContextRoutes.post(
  "/v1/signal/knowledge",
  zValidator("json", KnowledgeUpload),
  async (c) => {
    const { workspaceId } = c.var.signalTenancy;
    const { title, bodyMarkdown, tags } = c.req.valid("json");
    const scoped = withWorkspace(workspaceId);

    // Chunk + embed outside the transaction — both are CPU-only and
    // we want the DB holding time to be small.
    const chunks = chunkMarkdown(bodyMarkdown);
    const embeddings = await embedChunks(chunks);

    const doc = await scoped.knowledgeDocuments.insert({
      title,
      bodyMarkdown,
      tags: tags ?? [],
      createdBy: actorUserId(c),
    });
    if (chunks.length > 0) {
      await scoped.knowledgeChunks.insertMany(
        chunks.map((text, i) => ({
          documentId: doc.id,
          chunkIndex: i,
          chunkText: text,
          embedding: embeddings[i]!,
        })),
      );
    }

    logger.info(
      { workspaceId, documentId: doc.id, chunks: chunks.length },
      "signal_knowledge_uploaded",
    );
    return c.json(
      {
        id: doc.id,
        title: doc.title,
        tags: doc.tags,
        chunks: chunks.length,
        createdAt: doc.createdAt.toISOString(),
      },
      201,
    );
  },
);

signalContextRoutes.get("/v1/signal/knowledge", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const docs = await withWorkspace(workspaceId).knowledgeDocuments.list();
  return c.json({
    documents: docs.map((d) => ({
      id: d.id,
      title: d.title,
      tags: d.tags,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    })),
  });
});

signalContextRoutes.get("/v1/signal/knowledge/:id", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const id = c.req.param("id");
  const scoped = withWorkspace(workspaceId);
  const doc = await scoped.knowledgeDocuments.findById(id);
  if (!doc) return notFound(c);
  const chunks = await scoped.knowledgeChunks.listByDocument(id);
  return c.json({
    id: doc.id,
    title: doc.title,
    bodyMarkdown: doc.bodyMarkdown,
    tags: doc.tags,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    chunks: chunks
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((ch) => ({ index: ch.chunkIndex, text: ch.chunkText })),
  });
});

signalContextRoutes.delete("/v1/signal/knowledge/:id", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const id = c.req.param("id");
  const ok = await withWorkspace(workspaceId).knowledgeDocuments.softDelete(id);
  if (!ok) return notFound(c);
  return c.body(null, 204);
});

signalContextRoutes.post(
  "/v1/signal/knowledge/search",
  zValidator(
    "json",
    z.object({
      query: z.string().trim().min(1).max(2000),
      limit: z.number().int().min(1).max(50).optional(),
    }),
  ),
  async (c) => {
    const { workspaceId } = c.var.signalTenancy;
    const { query, limit } = c.req.valid("json");
    const hits = await searchKnowledge({
      workspaceId,
      query,
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json({
      query,
      hits: hits.map((h) => ({
        documentId: h.documentId,
        documentTitle: h.documentTitle,
        chunkIndex: h.chunkIndex,
        chunkText: h.chunkText,
        score: h.score,
        distance: h.distance,
      })),
    });
  },
);

// ─── CREDENTIALS ──────────────────────────────────────────────────────────
//
// The GET surface returns metadata only — adapter name, version,
// rotated_at, created_at. Decrypted payload is never returned over
// HTTP. Only the in-process ingestion runner should call
// `scoped.adapterCredentials.getFull()` + `decryptCredential(...)`.

const AdapterName = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9_.-]{0,62}$/, "adapter must match ^[a-z][a-z0-9_.-]{0,62}$");

signalContextRoutes.get("/v1/signal/credentials", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const rows = await withWorkspace(workspaceId).adapterCredentials.listMetadata();
  return c.json({
    credentials: rows.map((r) => ({
      adapter: r.adapter,
      payloadVersion: r.payloadVersion,
      rotatedAt: r.rotatedAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

signalContextRoutes.get("/v1/signal/credentials/:adapter", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const adapter = AdapterName.safeParse(c.req.param("adapter"));
  if (!adapter.success) return notFound(c);
  const row = await withWorkspace(workspaceId).adapterCredentials.getMetadata(adapter.data);
  if (!row) return notFound(c);
  return c.json({
    adapter: row.adapter,
    payloadVersion: row.payloadVersion,
    rotatedAt: row.rotatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });
});

signalContextRoutes.put(
  "/v1/signal/credentials/:adapter",
  zValidator(
    "json",
    z.object({ payload: z.record(z.unknown()) }),
  ),
  async (c) => {
    const { workspaceId } = c.var.signalTenancy;
    const adapter = AdapterName.safeParse(c.req.param("adapter"));
    if (!adapter.success) {
      return c.json(
        {
          type: "about:blank",
          title: "Bad Request",
          status: 400,
          detail: "adapter name must match ^[a-z][a-z0-9_.-]{0,62}$",
          instance: c.var.requestId,
        },
        400,
      );
    }
    const { payload } = c.req.valid("json");
    const ciphertext = encryptCredential(workspaceId, adapter.data, payload);
    const row = await withWorkspace(workspaceId).adapterCredentials.upsert({
      adapter: adapter.data,
      encryptedPayload: ciphertext,
    });
    logger.info(
      {
        workspaceId,
        adapter: adapter.data,
        payloadVersion: row.payloadVersion,
      },
      "signal_adapter_credential_rotated",
    );
    return c.json(
      {
        adapter: row.adapter,
        payloadVersion: row.payloadVersion,
        rotatedAt: row.rotatedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      },
      201,
    );
  },
);

signalContextRoutes.delete("/v1/signal/credentials/:adapter", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const adapter = AdapterName.safeParse(c.req.param("adapter"));
  if (!adapter.success) return notFound(c);
  const ok = await withWorkspace(workspaceId).adapterCredentials.remove(adapter.data);
  if (!ok) return notFound(c);
  return c.body(null, 204);
});

// Internal helper (NOT an HTTP route) — used by the ingestion runner
// inside the api process to fetch + decrypt a credential. Exported
// here so tests can exercise the end-to-end decrypt path without
// reaching into private module internals.
export async function readDecryptedAdapterCredential(args: {
  workspaceId: string;
  adapter: string;
}): Promise<unknown | undefined> {
  const scoped = withWorkspace(args.workspaceId);
  const row = await scoped.adapterCredentials.getFull(args.adapter);
  if (!row) return undefined;
  return decryptCredential(args.workspaceId, args.adapter, row.encryptedPayload);
}

// ─── GAPS ─────────────────────────────────────────────────────────────────

const GapStatus = z.enum(["open", "planned", "wontfix", "resolved"]);

const GapCreate = z.object({
  title: z.string().trim().min(1).max(500),
  bodyMarkdown: z.string().trim().min(1).max(100_000),
  status: GapStatus.optional(),
});

const GapUpdate = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  bodyMarkdown: z.string().trim().min(1).max(100_000).optional(),
  status: GapStatus.optional(),
});

signalContextRoutes.get("/v1/signal/gaps", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const rows = await db()
    .select()
    .from(schema.signalOnboardingGaps)
    .where(eq(schema.signalOnboardingGaps.workspaceId, workspaceId))
    .orderBy(desc(schema.signalOnboardingGaps.createdAt));
  return c.json({
    gaps: rows.map((r) => ({
      id: r.id,
      title: r.title,
      bodyMarkdown: r.bodyMarkdown,
      status: r.status,
      raisedBy: r.raisedBy,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
    })),
  });
});

signalContextRoutes.post(
  "/v1/signal/gaps",
  zValidator("json", GapCreate),
  async (c) => {
    const { workspaceId } = c.var.signalTenancy;
    const body = c.req.valid("json");
    const [row] = await withWorkspace(workspaceId).onboardingGaps.insert({
      title: body.title,
      bodyMarkdown: body.bodyMarkdown,
      status: body.status ?? "open",
      raisedBy: actorUserId(c),
    });
    return c.json(
      {
        id: row!.id,
        title: row!.title,
        bodyMarkdown: row!.bodyMarkdown,
        status: row!.status,
        raisedBy: row!.raisedBy,
        createdAt: row!.createdAt.toISOString(),
        resolvedAt: row!.resolvedAt?.toISOString() ?? null,
      },
      201,
    );
  },
);

signalContextRoutes.get("/v1/signal/gaps/:id", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const id = c.req.param("id");
  const row = await withWorkspace(workspaceId).onboardingGaps.findById(id);
  if (!row) return notFound(c);
  return c.json({
    id: row.id,
    title: row.title,
    bodyMarkdown: row.bodyMarkdown,
    status: row.status,
    raisedBy: row.raisedBy,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  });
});

signalContextRoutes.patch(
  "/v1/signal/gaps/:id",
  zValidator("json", GapUpdate),
  async (c) => {
    const { workspaceId } = c.var.signalTenancy;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const existing = await withWorkspace(workspaceId).onboardingGaps.findById(id);
    if (!existing) return notFound(c);

    const patch: Partial<typeof schema.signalOnboardingGaps.$inferInsert> = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.bodyMarkdown !== undefined) patch.bodyMarkdown = body.bodyMarkdown;
    if (body.status !== undefined) {
      patch.status = body.status;
      // Stamp resolved_at when moving to resolved (and only then).
      if (body.status === "resolved" && existing.status !== "resolved") {
        patch.resolvedAt = new Date();
      } else if (body.status !== "resolved" && existing.status === "resolved") {
        patch.resolvedAt = null;
      }
    }

    const [updated] = await db()
      .update(schema.signalOnboardingGaps)
      .set(patch)
      .where(
        and(
          eq(schema.signalOnboardingGaps.workspaceId, workspaceId),
          eq(schema.signalOnboardingGaps.id, id),
        ),
      )
      .returning();
    if (!updated) return notFound(c);
    return c.json({
      id: updated.id,
      title: updated.title,
      bodyMarkdown: updated.bodyMarkdown,
      status: updated.status,
      raisedBy: updated.raisedBy,
      createdAt: updated.createdAt.toISOString(),
      resolvedAt: updated.resolvedAt?.toISOString() ?? null,
    });
  },
);

signalContextRoutes.delete("/v1/signal/gaps/:id", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const id = c.req.param("id");
  const existing = await withWorkspace(workspaceId).onboardingGaps.findById(id);
  if (!existing) return notFound(c);
  await db()
    .delete(schema.signalOnboardingGaps)
    .where(
      and(
        eq(schema.signalOnboardingGaps.workspaceId, workspaceId),
        eq(schema.signalOnboardingGaps.id, id),
      ),
    );
  return c.body(null, 204);
});

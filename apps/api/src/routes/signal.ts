// Roster Signal · WS A core engine · HTTP surface.
//
// The routes here are gated by two upstream layers already wired in
// `app.ts`:
//   - `signalKillSwitch` short-circuits with 404 when
//     SIGNAL_SERVICES_ENABLED is false and 503 when the resolved
//     workspace's `signal_enabled` column is false.
//   - `sessionLoader` populates `c.var.auth`.
//
// This file adds a thin `requireSignalTenancy` step that resolves the
// current workspace from the auth payload, 401s when no session is
// present, and 403s when the session doesn't have a workspace to act
// on. Every handler reads the tenant from `c.var.signalTenancy` so
// cross-tenant leaks have to go through a tenancy helper that's part
// of the review checklist.

import { randomUUID } from "node:crypto";
import { db, schema } from "@cred/db";
import { withWorkspace } from "@cred/db/signal";
import type { ConsentApiTarget } from "@cred/db/signal";
import { lineageForCanonical, recordLineage, validateConsentTransition } from "@cred/db/signal";
import { logger } from "@cred/observability";
import { runExtracts } from "@cred/signal-extracts";
import { readWeights } from "@cred/signal-learn";
import { rankJobCandidates, rankProviderOpenings } from "@cred/signal-match";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { ApiBindings } from "../types.js";

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
    {
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      detail,
      instance: c.var.requestId,
    },
    403,
  );
}

function notFound(c: Context<ApiBindings>): Response {
  return c.json(
    { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
    404,
  );
}

/**
 * Resolve the Signal tenant from whatever session the request carries.
 * Staff sessions use the active workspace; provider sessions use the
 * case's workspace. Missing session → 401; session without a workspace
 * → 403. Non-Signal routes don't touch this middleware.
 */
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
  if (!workspaceId) {
    return forbidden(c, "No workspace on session.");
  }
  c.set("signalTenancy", { workspaceId });
  await next();
  return undefined;
}

export const signalRoutes = new Hono<ApiBindings>();

// All Signal routes share the same tenancy guard.
signalRoutes.use("/v1/signal/*", requireSignalTenancy);

// ─── GET /v1/signal/jobs/:id/ranking ───────────────────────────────────────
//
// Rank the providers in the current workspace against this job and
// snapshot the result into `signal_rankings`. The caller gets the
// freshly-computed list — not a cached one — so a recruiter who just
// edited a provider sees the effect immediately.
//
// Cache key is (workspace_id, job_id, YYYY-MM-DD(ranked_at)). The
// handler accepts `?fresh=1` to force a new ranking even if today's
// snapshot already exists; default is to prefer today's snapshot when
// it's still fresh.
signalRoutes.get("/v1/signal/jobs/:id/ranking", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const jobId = c.req.param("id");
  const fresh = c.req.query("fresh") === "1";

  const scoped = withWorkspace(workspaceId);
  const job = await scoped.jobs.findById(jobId);
  if (!job) return notFound(c);

  // Prefer today's snapshot unless the caller explicitly asked for a
  // fresh run. "Today" is UTC-date by rankedAt — see cache-key notes
  // in signal-match/src/rank.ts.
  if (!fresh) {
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    const cached = await db()
      .select()
      .from(schema.signalRankings)
      .where(
        and(
          eq(schema.signalRankings.workspaceId, workspaceId),
          eq(schema.signalRankings.jobId, jobId),
        ),
      )
      .orderBy(desc(schema.signalRankings.rankedAt))
      .limit(1);
    const row = cached[0];
    if (row && row.rankedAt.getTime() >= todayUtc.getTime()) {
      return c.json({
        jobId: row.jobId,
        rankingId: row.id,
        rankedAt: row.rankedAt.toISOString(),
        cached: true,
        candidates: row.entries,
      });
    }
  }

  const weights = await readWeights({ workspaceId });
  const result = await rankJobCandidates({ workspaceId, jobId, weights });

  return c.json({
    jobId,
    rankingId: result.rankingId,
    rankedAt: result.rankedAt.toISOString(),
    cached: false,
    candidates: result.candidates.map((c2) => ({
      providerId: c2.providerId,
      score: c2.score,
      earliestStartDate: c2.earliestStartDate,
      confidence: c2.confidence,
      bindingCredential: c2.bindingCredential,
      reasons: c2.reasons.map((r) => ({
        code: r.facet.facet,
        facet: r.facet,
        humanPhrasing: r.humanPhrasing,
        sourceLineage: {
          table: r.sourceLineageRef.canonicalTable,
          rowId: r.sourceLineageRef.canonicalId,
        },
      })),
    })),
  });
});

// ─── GET /v1/signal/providers/:id/fit ──────────────────────────────────────
//
// Reverse query: openings this provider is a fit for. Does NOT write a
// per-provider snapshot (see signal-match/src/reverse.ts for why).
signalRoutes.get("/v1/signal/providers/:id/fit", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const providerId = c.req.param("id");

  const scoped = withWorkspace(workspaceId);
  const provider = await scoped.providers.findById(providerId);
  if (!provider) return notFound(c);

  const weights = await readWeights({ workspaceId });
  const result = await rankProviderOpenings({ workspaceId, providerId, weights });

  return c.json({
    providerId,
    openings: result.openings.map((o) => ({
      jobId: o.jobId,
      score: o.score,
      earliestStartDate: o.earliestStartDate,
      confidence: o.confidence,
      bindingCredential: o.bindingCredential,
      reasons: o.reasons.map((r) => ({
        code: r.facet.facet,
        facet: r.facet,
        humanPhrasing: r.humanPhrasing,
        sourceLineage: {
          table: r.sourceLineageRef.canonicalTable,
          rowId: r.sourceLineageRef.canonicalId,
        },
      })),
    })),
  });
});

// ─── POST /v1/signal/overrides ────────────────────────────────────────────
//
// Recruiter promote/demote. Idempotent per (workspace, job, provider,
// recruiter). A POST that hits an existing row updates direction +
// reason + at; no new row is inserted. Captured for the learn worker
// so repeated nudges on the same candidate don't skew the weight more
// than a single decision would.
const OverrideBody = z.object({
  jobId: z.string().uuid(),
  providerId: z.string().uuid(),
  direction: z.enum(["pin", "unpin", "promote", "demote"]),
  reason: z.string().min(1).max(500),
});

signalRoutes.post("/v1/signal/overrides", zValidator("json", OverrideBody), async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const auth = c.var.auth;
  if (!auth) return unauthorized(c);
  const userId = auth.session.kind === "staff" ? auth.session.userId : null;
  const body = c.req.valid("json");

  const scoped = withWorkspace(workspaceId);
  const [job, provider] = await Promise.all([
    scoped.jobs.findById(body.jobId),
    scoped.providers.findById(body.providerId),
  ]);
  if (!job || !provider) return notFound(c);

  // Idempotency key is (workspace, job, provider, user). We implement
  // it in two steps rather than via `ON CONFLICT` because the base
  // table has no partial unique index on this tuple — adding one here
  // would ship a migration for a case the ranker can police in-line.
  const existing = await db()
    .select()
    .from(schema.signalOverrides)
    .where(
      and(
        eq(schema.signalOverrides.workspaceId, workspaceId),
        eq(schema.signalOverrides.jobId, body.jobId),
        eq(schema.signalOverrides.providerId, body.providerId),
        userId
          ? eq(schema.signalOverrides.userId, userId)
          : // `userId IS NULL` branch — a provider-session override.
            eq(schema.signalOverrides.userId, schema.signalOverrides.userId),
      ),
    )
    .limit(1);

  const now = new Date();
  let overrideId: string;
  let created: boolean;
  const prior = existing[0];
  if (prior && (userId === null || prior.userId === userId)) {
    await db()
      .update(schema.signalOverrides)
      .set({ direction: body.direction, reasonText: body.reason, at: now })
      .where(eq(schema.signalOverrides.id, prior.id));
    overrideId = prior.id;
    created = false;
  } else {
    const [row] = await scoped.overrides.insert({
      jobId: body.jobId,
      providerId: body.providerId,
      userId: userId ?? null,
      direction: body.direction,
      reasonText: body.reason,
      at: now,
    });
    if (!row) {
      logger.error({ workspaceId, body }, "signal_override_insert_returned_no_row");
      return c.json(
        {
          type: "about:blank",
          title: "Failed to record override",
          status: 500,
          instance: c.var.requestId,
        },
        500,
      );
    }
    overrideId = row.id;
    created = true;
  }

  return c.json(
    {
      overrideId,
      jobId: body.jobId,
      providerId: body.providerId,
      direction: body.direction,
      reason: body.reason,
      at: now.toISOString(),
      created,
    },
    created ? 201 : 200,
  );
});

// ─── GET /v1/signal/reasons/:reason_id/source ─────────────────────────────
//
// Deep-link resolver. `reason_id` is a composite key the ranker returns
// inside each reason: `{table}:{rowId}`. We look that up in
// `signal_source_lineage` and return every external-system entry so the
// cockpit can render "pulled from inbound_emails/<uuid>" and route to
// the originating record.
signalRoutes.get("/v1/signal/reasons/:reason_id/source", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const raw = c.req.param("reason_id");
  // Compact form "table:rowId" keeps the URL short and lets the FE
  // thread the pair through a single path segment. A UUID in isolation
  // is unresolvable here — we always need both halves.
  const parts = raw.split(":");
  if (parts.length !== 2) {
    return c.json(
      {
        type: "about:blank",
        title: "Bad reason id",
        status: 400,
        detail: "Expected reason_id of the form '<table>:<uuid>'.",
        instance: c.var.requestId,
      },
      400,
    );
  }
  const [canonicalTable, canonicalId] = parts as [string, string];

  const lineageRows = await lineageForCanonical(db(), {
    workspaceId,
    canonicalTable,
    canonicalId,
  });
  if (lineageRows.length === 0) return notFound(c);

  return c.json({
    canonicalTable,
    canonicalId,
    sources: lineageRows.map((r) => ({
      id: r.id,
      externalSystem: r.externalSystem,
      externalId: r.externalId,
      canonicalTable: r.canonicalTable,
      canonicalId: r.canonicalId,
      lastSynced: r.lastSynced.toISOString(),
    })),
  });
});

// ─── POST /v1/signal/conversations/consent ────────────────────────────────
//
// Consent state update (grant / revoke / move to pending / clear).
// The state machine itself lives in `@cred/db/signal` (consent.ts) so
// the ranker and the ingest pipeline see the same rules — this
// handler is a thin surface over it.
//
// Rules the surface enforces:
//
//   - `implied_outbound` rows are frozen (ingest-only). The handler
//     refuses to flip them; see `validateConsentTransition`.
//   - The addressable target set excludes `implied_outbound` for the
//     same reason — there is no consent event that moves a row INTO
//     that state from outside ingest.
//   - On a successful `revoked` transition, we also null the body
//     column so the stored copy of the content vanishes; occurred_at,
//     channel, and lineage stay so audit can still show "a thread
//     existed here, these were the headers, the body is gone". The
//     ranker's extract-filter (see `extractsForWorkspace`) joins back
//     to the conversation's consent_state, so no extra write to
//     `signal_extracts` is needed here.
const ConsentBody = z.object({
  conversationId: z.string().uuid(),
  // Mirror of `ConsentApiTarget` in @cred/db/signal. The type-level
  // assertion below fails the build if the two drift.
  state: z.enum(["granted", "revoked", "pending", "unknown"]),
});
// Compile-time guard: the Zod enum equals the state machine's
// addressable target set. If `ConsentApiTarget` grows a new member
// the TS error here forces us to teach the Zod enum.
type _ConsentApiTargetsMatch = ConsentApiTarget extends z.infer<typeof ConsentBody>["state"]
  ? z.infer<typeof ConsentBody>["state"] extends ConsentApiTarget
    ? true
    : never
  : never;
const _consentApiTargetsMatch: _ConsentApiTargetsMatch = true;
void _consentApiTargetsMatch;

signalRoutes.post(
  "/v1/signal/conversations/consent",
  zValidator("json", ConsentBody),
  async (c) => {
    const { workspaceId } = c.var.signalTenancy;
    const body = c.req.valid("json");
    const nextState = body.state;

    // Load the current state first so the transition check can act on
    // it. A single row lookup → keeps us on one round-trip + one
    // conditional update when the transition is legal.
    const existing = await db()
      .select({
        id: schema.signalConversations.id,
        consentState: schema.signalConversations.consentState,
      })
      .from(schema.signalConversations)
      .where(
        and(
          eq(schema.signalConversations.workspaceId, workspaceId),
          eq(schema.signalConversations.id, body.conversationId),
        ),
      )
      .limit(1);
    const prior = existing[0];
    if (!prior) return notFound(c);

    const err = validateConsentTransition(prior.consentState, nextState);
    if (err) {
      return c.json(
        {
          type: `https://errors.cred/signal/consent/${err.code}`,
          title: "Consent transition refused",
          status: 409,
          detail: err.detail,
          instance: c.var.requestId,
        },
        409,
      );
    }

    // Revoke → null the body as part of the same write. Non-revoked
    // transitions leave the body untouched.
    const setExpr: Partial<typeof schema.signalConversations.$inferInsert> = {
      consentState: nextState,
    };
    if (nextState === "revoked") setExpr.body = null;

    const updated = await db()
      .update(schema.signalConversations)
      .set(setExpr)
      .where(
        and(
          eq(schema.signalConversations.workspaceId, workspaceId),
          eq(schema.signalConversations.id, body.conversationId),
        ),
      )
      .returning();
    const row = updated[0];
    if (!row) return notFound(c);

    return c.json({
      conversationId: row.id,
      consentState: row.consentState,
      bodyPresent: row.body !== null,
    });
  },
);

// ─── POST /v1/signal/eval/runs ────────────────────────────────────────────
//
// Eval harness enqueue. For v0 we record the request as a conversation
// row of channel="eval" so there's a durable queue to drain; WS G will
// wire a worker against that same `kind` filter. Keeping the enqueue in
// `signal_conversations` avoids shipping a new table for a stub.
const EvalBody = z.object({
  suite: z.string().min(1).max(200),
  notes: z.string().max(2000).optional(),
});

signalRoutes.post("/v1/signal/eval/runs", zValidator("json", EvalBody), async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const body = c.req.valid("json");

  const [row] = await db()
    .insert(schema.signalConversations)
    .values({
      workspaceId,
      channel: "eval",
      consentState: "unknown",
      summary: `eval:${body.suite}`,
      sourceRef: {
        kind: "eval_request",
        suite: body.suite,
        ...(body.notes ? { notes: body.notes } : {}),
      },
    })
    .returning();

  return c.json(
    {
      runId: row?.id ?? null,
      suite: body.suite,
      status: "queued",
    },
    202,
  );
});

// ─── POST /v1/signal/extracts/run ─────────────────────────────────────────
//
// Dev trigger for the extract pipeline. In prod WS G will run this on
// an hourly cron (not yet wired — see WS E deliverables doc), so for
// now a recruiter can hit this endpoint to re-extract after a batch
// of outreach. The handler returns the extract summary so the cockpit
// can show "+N facets written" immediately.
//
// Idempotent: a re-run against unchanged conversation bodies inserts
// zero rows (the migration adds a partial unique index on
// (conversation_id, facet, source_span.start) that the runner relies
// on via ON CONFLICT DO NOTHING).
signalRoutes.post("/v1/signal/extracts/run", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const result = await runExtracts({ workspaceId });
  return c.json({
    workspaceId,
    conversationsProcessed: result.conversationsProcessed,
    extractsInserted: result.extractsInserted,
    extractsSkipped: result.extractsSkipped,
    bodiesHidden: result.bodiesHidden,
  });
});

// ─── POST /v1/signal/ingest/:adapter/webhook ──────────────────────────────
//
// HMAC-validated ingress. The adapter name is a free-form string that
// maps to an env-supplied secret (`SIGNAL_INGEST_<ADAPTER>_SECRET`,
// upper-cased). When no secret is configured the request is rejected
// with 401 — the stub explicitly does NOT short-circuit as "anyone can
// post" because turning that into prod behaviour is a one-flag flip.
//
// Tenant resolution: for v0 we trust the session that reached the
// kill-switch's workspace check. An adapter-side credential-to-tenant
// map is a follow-up; the config surface for that lives in WS H.
signalRoutes.post("/v1/signal/ingest/:adapter/webhook", async (c) => {
  const { workspaceId } = c.var.signalTenancy;
  const adapter = c.req.param("adapter");
  const signature = c.req.header("x-signal-signature");

  const rawBody = await c.req.text();

  const envKey = `SIGNAL_INGEST_${adapter.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_SECRET`;
  const secret = process.env[envKey];
  if (!secret) {
    // Adapter has no secret wired — refuse to accept the event. This
    // protects against the "forgot to configure the HMAC" footgun that
    // would otherwise land unauthenticated webhook traffic in Signal.
    return c.json(
      {
        type: "https://errors.cred/signal/ingest_adapter_not_configured",
        title: `Ingest adapter '${adapter}' has no HMAC secret configured`,
        status: 401,
        instance: c.var.requestId,
      },
      401,
    );
  }
  if (!signature || !(await verifyHmac(rawBody, secret, signature))) {
    return c.json(
      {
        type: "about:blank",
        title: "Invalid HMAC signature",
        status: 401,
        instance: c.var.requestId,
      },
      401,
    );
  }

  // Minimal payload shape — we accept a free-form payload so adapter
  // owners can start sending today and the ingestion pipeline (WS C)
  // can iterate the shape without invalidating the HMAC path.
  let parsedBody: unknown;
  try {
    parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : {};
  } catch {
    return c.json(
      {
        type: "about:blank",
        title: "Body is not valid JSON",
        status: 400,
        instance: c.var.requestId,
      },
      400,
    );
  }

  const [row] = await db()
    .insert(schema.signalConversations)
    .values({
      workspaceId,
      channel: `ingest:${adapter}`,
      consentState: "unknown",
      summary: `ingest ${adapter}`,
      sourceRef: {
        adapter,
        payload: parsedBody as Record<string, unknown>,
      },
    })
    .returning();

  if (!row) {
    logger.error({ workspaceId, adapter }, "signal_ingest_conversation_insert_returned_no_row");
    return c.json(
      {
        type: "about:blank",
        title: "Failed to record ingest",
        status: 500,
        instance: c.var.requestId,
      },
      500,
    );
  }

  // Record lineage back to the adapter's own id (falling back to a
  // random one so the row is still queryable by its `signal_source_
  // lineage.external_id`).
  const externalId =
    typeof (parsedBody as { id?: unknown })?.id === "string"
      ? (parsedBody as { id: string }).id
      : randomUUID();
  await recordLineage(db(), {
    workspaceId,
    canonicalTable: "signal_conversations",
    canonicalId: row.id,
    externalSystem: adapter,
    externalId,
  });

  return c.json({ conversationId: row.id, accepted: true }, 202);
});

/**
 * Timing-safe HMAC-SHA256 verification.
 *
 * Accepts both plain hex and `sha256=<hex>` prefixed signatures so the
 * same handler works with GitHub-style and Stripe-style adapters out
 * of the box.
 */
async function verifyHmac(payload: string, secret: string, signature: string): Promise<boolean> {
  // `crypto.subtle` lives on globalThis in modern Node; we call into it
  // via a dynamic import to keep this module tree-shakeable for test
  // bundlers that don't like unconditional node:crypto imports.
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const normalized = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;
  if (!/^[0-9a-f]+$/i.test(normalized) || normalized.length % 2 !== 0) return false;
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(normalized, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

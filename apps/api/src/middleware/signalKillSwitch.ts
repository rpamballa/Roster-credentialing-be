// Signal kill-switch middleware (WS H · dev infra plumbing).
//
// Signal is dev-only until an eval harness passes with consultant-labeled
// data (see implementation plan section 8). To keep it out of prod by
// accident, three layers gate every `/v1/signal/*` request:
//
//   1. SIGNAL_SERVICES_ENABLED env flag (service-wide). When false,
//      every `/v1/signal/*` route 404s — the router behaves as though
//      Signal does not exist. This is the big red button for the
//      whole service.
//
//   2. workspaces.signal_enabled column (per tenant). When false for
//      the resolved workspace, routes return 503 Service Unavailable
//      with a clear problem+json body — the service exists but this
//      tenant hasn't been whitelisted onto it yet.
//
//   3. The CI gate in .github/workflows/deploy.yml, which refuses to
//      deploy `signal-*` services to prod without the repo variable
//      SIGNAL_PROD_UNLOCKED == "true".
//
// This middleware owns layers (1) and (2). It must run BEFORE any
// `/v1/signal/*` handler is mounted — see apps/api/src/app.ts.

import { env } from "@cred/config";
import { db, schema } from "@cred/db";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { ApiBindings } from "../types.js";

const SIGNAL_PATH_PREFIX = "/v1/signal/";

function notFound(c: Context<ApiBindings>): Response {
  // Mirror the app-level 404 shape so callers can't tell this came from
  // the kill switch vs. a genuinely missing route. That's intentional:
  // when SIGNAL_SERVICES_ENABLED is false we want the surface to behave
  // as though Signal doesn't exist at all.
  return c.json(
    { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
    404,
  );
}

function serviceUnavailable(c: Context<ApiBindings>): Response {
  return c.json(
    {
      type: "https://errors.cred/signal/disabled_for_workspace",
      title: "Signal is not enabled for this workspace",
      status: 503,
      detail:
        "The Signal product is not enabled for this tenant. Contact support if you believe this is an error.",
      instance: c.var.requestId,
    },
    503,
  );
}

/**
 * Resolve the workspaceId for the current request from the already-
 * loaded session. Returns undefined when there is no session or no
 * active workspace — the handler chain will emit the usual 401/403 in
 * that case; we don't want the kill switch to double-respond with
 * something misleading.
 *
 * Staff sessions: use the active workspace.
 * Provider sessions: use the case's workspace.
 *
 * NB: this intentionally does NOT depend on `requireTenancy` having
 * run, because the kill switch must execute BEFORE any Signal-specific
 * auth/tenancy middleware — the whole point is to short-circuit the
 * request before the service does any real work.
 */
function resolveWorkspaceId(c: Context<ApiBindings>): string | undefined {
  const auth = c.var.auth;
  if (!auth) return undefined;
  if (auth.session.kind === "staff") {
    return auth.session.activeWorkspaceId ?? undefined;
  }
  if (auth.session.kind === "provider") {
    return auth.session.caseWorkspaceId ?? undefined;
  }
  return undefined;
}

/**
 * Gate every `/v1/signal/*` request:
 *   - SIGNAL_SERVICES_ENABLED=false → 404 (service-wide off)
 *   - workspace resolvable + signal_enabled=false → 503 (tenant off)
 *   - workspace not resolvable → pass through; downstream auth/tenancy
 *     middleware will 401/403 as appropriate
 *   - signal_enabled=true → proceed
 *
 * Non-Signal paths pass through untouched so this can be mounted at
 * `app.use("*", ...)` without penalising the rest of the API — see
 * `isSignalPath` below for the cheap pre-check.
 */
export const signalKillSwitch: MiddlewareHandler<ApiBindings> = async (c, next) => {
  if (!isSignalPath(c.req.path)) {
    return next();
  }

  // Layer 1: service-wide gate. If Signal is off at the env level,
  // return 404 before touching the DB. This is both an optimisation
  // (no query per request) and a security property (no SQL cost
  // amplification from a disabled feature).
  if (!env().SIGNAL_SERVICES_ENABLED) {
    return notFound(c);
  }

  // Layer 2: per-workspace gate. We need a workspace to check the
  // column against; if there isn't one on the session yet, pass
  // through and let the downstream auth/tenancy middleware emit the
  // real 401/403. Returning our own 503 here would hide auth issues.
  const workspaceId = resolveWorkspaceId(c);
  if (!workspaceId) {
    return next();
  }

  // rls: bypass — the kill-switch read has to happen BEFORE any
  // tenancy transaction is opened; it's a single-row scalar read of a
  // kill-switch column, by uuid primary key, which carries no tenant
  // data.
  const [row] = await db()
    .select({ signalEnabled: schema.workspaces.signalEnabled })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  if (!row || !row.signalEnabled) {
    return serviceUnavailable(c);
  }

  await next();
};

/**
 * Is this path under the `/v1/signal/` prefix? Exported so `app.ts`
 * (and tests) can reuse the single source of truth for what "a Signal
 * path" means.
 */
export function isSignalPath(path: string): boolean {
  return path.startsWith(SIGNAL_PATH_PREFIX);
}

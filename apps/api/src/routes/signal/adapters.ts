// Roster Signal · ingestion framework HTTP surface.
//
// Mounted on the existing `signalRoutes` Hono instance so it inherits
// the `requireSignalTenancy` middleware and the upstream kill switch.
// Every handler reads the tenant from `c.var.signalTenancy` — same as
// the rest of /v1/signal/*.
//
// Permissioning: the user story names `signal.write` / `signal.read`
// as the gates for mutating vs. inspecting these routes. Signal doesn't
// yet have a fine-grained permission model (staff-with-workspace is
// the current bar, enforced by `requireSignalTenancy`), so for v0 any
// authenticated staff member with workspace access can run these.
// The handlers carry a `TODO(perm): require signal.write` comment at
// the mutation sites so the follow-up lands in exactly the right place
// without hunting.

import { logger } from "@cred/observability";
import {
  type AdapterContract,
  type RunOnceResult,
  adapterHealth,
  defaultAdapterRegistry,
  preview as previewAdapter,
  resetAdapterState,
  runOnce,
  UnknownAdapterError,
} from "@cred/signal-ingest";
import type { Context, Hono } from "hono";
import type { ApiBindings } from "../../types.js";

function notFound(c: Context<ApiBindings>, detail: string): Response {
  return c.json(
    {
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail,
      instance: c.var.requestId,
    },
    404,
  );
}

/**
 * Attach `/v1/signal/adapters/*` to an existing `signalRoutes`
 * instance. This keeps the tenancy middleware wiring in one place
 * (signal.ts) without ballooning that file.
 */
export function mountAdapterRoutes(signalRoutes: Hono<ApiBindings>): void {
  // ─── GET /v1/signal/adapters ────────────────────────────────────
  //
  // List every registered adapter with its current (workspace-scoped)
  // health status. The onboarding UI renders this as the "connectors"
  // list; `roster-internal` lights up green, every external stub
  // reads "not configured" until a real customer wires it.
  signalRoutes.get("/v1/signal/adapters", async (c) => {
    const { workspaceId } = c.var.signalTenancy;
    const items = await Promise.all(
      defaultAdapterRegistry.all().map(async (adapter: AdapterContract) => {
        try {
          const report = await adapterHealth({ workspaceId, adapter: adapter.name });
          return {
            name: adapter.name,
            supports: adapter.supports,
            cadenceMs: adapter.cadenceMs,
            ok: report.ok,
            detail: report.detail,
            breakerState: report.breakerState,
            lastSyncAt: report.lastSyncAt,
            lastSuccessAt: report.lastSuccessAt,
            lastErrorAt: report.lastErrorAt,
            lastError: report.lastError ?? null,
            consecutiveFailures: report.consecutiveFailures,
          };
        } catch (err: unknown) {
          logger.error(
            {
              workspaceId,
              adapter: adapter.name,
              err: err instanceof Error ? err.message : String(err),
            },
            "adapter list health failed",
          );
          return {
            name: adapter.name,
            supports: adapter.supports,
            cadenceMs: adapter.cadenceMs,
            ok: false,
            detail: `${adapter.name}: health probe threw`,
            breakerState: "closed" as const,
            lastSyncAt: null,
            lastSuccessAt: null,
            lastErrorAt: null,
            lastError: err instanceof Error ? err.message : String(err),
            consecutiveFailures: 0,
          };
        }
      }),
    );
    return c.json({ adapters: items });
  });

  // ─── POST /v1/signal/adapters/:adapter/sync ────────────────────
  //
  // Manual trigger — the onboarding UI's "sync now" button and the
  // crontab's single-adapter cron hook both call this.
  // TODO(perm): require signal.write once the permission model lands.
  //
  // Status policy: we return 200 for every structured response and
  // let the client branch on `result.ok` + `result.notImplemented`.
  // A 5xx on these routes gets intercepted by Cloudflare's edge and
  // the structured body (which carries the required-credentials
  // diagnostics the onboarding UI needs) never reaches the browser.
  // Unknown adapters still 404, and genuine handler crashes still
  // propagate to the generic error middleware.
  signalRoutes.post("/v1/signal/adapters/:adapter/sync", async (c) => {
    const { workspaceId } = c.var.signalTenancy;
    const adapter = c.req.param("adapter");
    try {
      const result: RunOnceResult = await runOnce({ workspaceId, adapter });
      return c.json(result);
    } catch (err: unknown) {
      if (err instanceof UnknownAdapterError) {
        return notFound(c, err.message);
      }
      throw err;
    }
  });

  // ─── POST /v1/signal/adapters/:adapter/preview ─────────────────
  //
  // Dry-run; returns the AdapterPreview without touching signal_*.
  // Safe to call repeatedly; onboarding UI calls on every page load.
  // Same status policy as /sync above.
  signalRoutes.post("/v1/signal/adapters/:adapter/preview", async (c) => {
    const { workspaceId } = c.var.signalTenancy;
    const adapter = c.req.param("adapter");
    try {
      const result = await previewAdapter({ workspaceId, adapter });
      return c.json(result);
    } catch (err: unknown) {
      if (err instanceof UnknownAdapterError) {
        return notFound(c, err.message);
      }
      throw err;
    }
  });

  // ─── GET /v1/signal/adapters/:adapter/health ───────────────────
  signalRoutes.get("/v1/signal/adapters/:adapter/health", async (c) => {
    const { workspaceId } = c.var.signalTenancy;
    const adapter = c.req.param("adapter");
    try {
      const report = await adapterHealth({ workspaceId, adapter });
      return c.json(report);
    } catch (err: unknown) {
      if (err instanceof UnknownAdapterError) {
        return notFound(c, err.message);
      }
      throw err;
    }
  });

  // ─── DELETE /v1/signal/adapters/:adapter/state ─────────────────
  //
  // Emergency recovery: clear the cursor + breaker. Used when an
  // operator has convinced themselves the vendor is back and wants
  // the next cron tick to try again cleanly.
  // TODO(perm): require signal.write once the permission model lands.
  signalRoutes.delete("/v1/signal/adapters/:adapter/state", async (c) => {
    const { workspaceId } = c.var.signalTenancy;
    const adapter = c.req.param("adapter");
    try {
      await resetAdapterState({ workspaceId, adapter });
      return c.json({ workspaceId, adapter, reset: true });
    } catch (err: unknown) {
      if (err instanceof UnknownAdapterError) {
        return notFound(c, err.message);
      }
      throw err;
    }
  });
}

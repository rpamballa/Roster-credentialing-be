/**
 * Shared factory for the external-adapter stubs. Every vendor adapter
 * — Bullhorn, Avionté, LaborEdge, Salesforce CRM, Gmail, Outlook,
 * RingCentral, Twilio — ships behind this factory until the first
 * customer with that vendor onboards. Centralising the stub shape
 * guarantees that:
 *
 *   • every stub refuses `sync/backfill/preview` with the SAME
 *     structured error (`NotImplementedForOnboarding`), so the
 *     onboarding engineer sees a consistent report across adapters
 *     when they look at the health surface;
 *
 *   • `health()` always returns `{ ok: false, lastError:
 *     'not configured' }`, which the GET /v1/signal/adapters route
 *     relies on to render the "waiting for first-customer wire-up"
 *     chip without the adapter having to know anything about the
 *     HTTP surface.
 *
 * When a vendor is wired for real, DELETE the stub call and replace
 * the file's export with a concrete `AdapterContract`. The stub
 * factory stays in-place for the next vendor.
 */

import type {
  AdapterBackfillResult,
  AdapterCapability,
  AdapterContext,
  AdapterContract,
  AdapterHealth,
  AdapterPreview,
  AdapterSyncResult,
} from "../contract.js";
import { NotImplementedForOnboarding } from "../contract.js";

export interface ExternalStubSpec {
  name: string;
  supports: readonly AdapterCapability[];
  /**
   * Cadence the real adapter will run at once implemented. Documented
   * on the stub so the scheduler's cadence table doesn't need to be
   * updated when the stub flips to real code.
   */
  cadenceMs: number | null;
  /** One-line vendor description; shown in the health detail string. */
  description: string;
  requiredCredentials: readonly string[];
  requiredScopes?: readonly string[];
  /** Env vars that must be present for the real adapter to start. */
  requiredEnv?: readonly string[];
  /** Vendor docs URL — surfaced on the error for easy copy/paste. */
  docs?: string;
}

/**
 * Build a `AdapterContract` whose payload methods throw and whose
 * health reports "not configured".
 */
export function makeExternalStub(spec: ExternalStubSpec): AdapterContract {
  function throwNotImplemented(method: string): never {
    const required: NotImplementedForOnboarding["required"] = {
      credentials: [...spec.requiredCredentials],
    };
    if (spec.requiredScopes && spec.requiredScopes.length > 0) {
      required.scopes = [...spec.requiredScopes];
    }
    if (spec.requiredEnv && spec.requiredEnv.length > 0) {
      required.env = [...spec.requiredEnv];
    }
    if (spec.docs) required.docs = spec.docs;
    throw new NotImplementedForOnboarding(
      spec.name,
      `${spec.name}.${method} will be implemented when the first customer with ${spec.description} onboards.`,
      required,
    );
  }

  return {
    name: spec.name,
    supports: spec.supports,
    cadenceMs: spec.cadenceMs,
    preview(_ctx: AdapterContext): Promise<AdapterPreview> {
      throwNotImplemented("preview");
    },
    sync(_ctx: AdapterContext, _cursor: unknown): Promise<AdapterSyncResult> {
      throwNotImplemented("sync");
    },
    backfill(_ctx: AdapterContext, _since: Date): Promise<AdapterBackfillResult> {
      throwNotImplemented("backfill");
    },
    async health(_ctx: AdapterContext): Promise<AdapterHealth> {
      return {
        ok: false,
        detail: `${spec.name}: not configured (stub awaiting first-customer wire-up).`,
        lastError: "not configured",
        diagnostics: {
          requiredCredentials: [...spec.requiredCredentials],
          ...(spec.requiredScopes ? { requiredScopes: [...spec.requiredScopes] } : {}),
          ...(spec.requiredEnv ? { requiredEnv: [...spec.requiredEnv] } : {}),
          ...(spec.docs ? { docs: spec.docs } : {}),
        },
      };
    },
  };
}

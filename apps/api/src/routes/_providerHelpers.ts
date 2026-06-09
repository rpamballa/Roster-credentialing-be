// Shared provider-session helpers.
//
// The provider auth model is "caseload of one": a provider session is bound
// to exactly one caseId. Every `/v1/cases/<id>/*` handler must check that
// the path's caseId matches the session's caseId — otherwise a valid
// provider session for case A could pull data for case B in the same
// workspace. This file centralises that check.

import type { Context } from "hono";
import type { ApiBindings } from "../types.js";

/**
 * Returns null when the request's `:caseId` path param matches the
 * provider session's bound caseId. Otherwise returns a 403 response.
 *
 * Usage:
 *
 *   const guard = assertSessionOwnsCase(c);
 *   if (guard) return guard;
 *
 * Requires `requireProviderAuth` middleware upstream — reads
 * `c.var.providerAuth.session.caseId`.
 */
export function assertSessionOwnsCase(
  c: Context<ApiBindings>,
  paramName = "caseId",
): Response | null {
  const auth = c.var.providerAuth;
  if (!auth) {
    return c.json(
      { type: "about:blank", title: "Unauthorized", status: 401, instance: c.var.requestId },
      401,
    );
  }
  const caseIdParam = c.req.param(paramName);
  if (caseIdParam !== auth.session.caseId) {
    return c.json(
      { type: "about:blank", title: "Forbidden", status: 403, instance: c.var.requestId },
      403,
    );
  }
  return null;
}

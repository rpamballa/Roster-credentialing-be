/**
 * Signal · consent state machine + body-visibility helper.
 * --------------------------------------------------------
 *
 * The `signal_conversations.consent_state` column governs what the
 * ranker and UI are allowed to read out of a conversation. We settled
 * on five states for v0, picked to cover the CAN-SPAM / TCPA stance
 * the seed agency ships under:
 *
 *   `granted`           — explicit opt-in. Body is visible.
 *   `implied_outbound`  — outbound-only content WE authored (emails we
 *                         sent, internal recruiter case notes). Body
 *                         is visible because it's our own writing, not
 *                         a provider's private reply. No consent is
 *                         required for an outbound business touch.
 *   `pending`           — inbound seen, consent not yet gathered. Body
 *                         is hidden: metadata (occurred_at, channel)
 *                         is kept so the queue can surface the thread
 *                         for a recruiter to triage.
 *   `revoked`           — provider pulled consent. Body is hidden and
 *                         previously-derived extracts are filtered out
 *                         of the ranker (see `extractsForWorkspace`
 *                         in `@cred/signal-extracts`), but the row
 *                         itself is retained for audit.
 *   `unknown`           — pre-v0 data where state was never recorded.
 *                         Body is hidden — we err conservative until
 *                         the recruiter resolves the row.
 *
 * Transitions are permissive: a recruiter can mark a `pending` row
 * either way, a `granted` row can be `revoked`, and a `revoked` row
 * can be re-`granted` after a new opt-in. We DO forbid two things:
 *
 *   - leaving the `implied_outbound` state through the consent API.
 *     Those rows are our own outbound content and the recruiter
 *     doesn't "revoke" an email she sent; marking them `revoked` would
 *     lose outbound history. If this becomes needed we add a separate
 *     "delete outbound record" endpoint.
 *   - setting a row to `implied_outbound` through the consent API.
 *     That state is reserved for ingest-time stamping.
 *
 * Programmable here (not as a DB CHECK) because we expect the states
 * to evolve as we wire more channels in v1 and a DB check would need
 * a migration per change.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../client.js";
import { signalConversations } from "../schema/signal/conversations.js";

export type ConsentState = "granted" | "revoked" | "pending" | "implied_outbound" | "unknown";

export const CONSENT_STATES: readonly ConsentState[] = [
  "granted",
  "revoked",
  "pending",
  "implied_outbound",
  "unknown",
] as const;

/**
 * Body is readable when the state is one we authored (`implied_outbound`)
 * or when the counterparty explicitly consented (`granted`). Everything
 * else is conservative: `pending` / `revoked` / `unknown` → no body.
 */
export function isBodyVisible(state: string | null | undefined): boolean {
  return state === "granted" || state === "implied_outbound";
}

/**
 * The (possibly-restricted) subset of states the consent API is
 * allowed to transition a row into. `implied_outbound` is owned by
 * ingest, not by the consent API, so it's deliberately absent here.
 */
export type ConsentApiTarget = "granted" | "revoked" | "pending" | "unknown";

export const CONSENT_API_TARGETS: readonly ConsentApiTarget[] = [
  "granted",
  "revoked",
  "pending",
  "unknown",
] as const;

export interface ConsentTransitionError {
  code: "frozen_outbound" | "invalid_target";
  detail: string;
}

/**
 * Decide whether `current → next` is a legal API transition. Returns
 * null on success; a `{code, detail}` on refusal so the caller can
 * map it to a Problem+JSON body with a specific type URL.
 */
export function validateConsentTransition(
  current: string,
  next: ConsentApiTarget,
): ConsentTransitionError | null {
  if (current === "implied_outbound") {
    return {
      code: "frozen_outbound",
      detail:
        "Conversations stamped `implied_outbound` by ingest cannot be re-stated through the consent API.",
    };
  }
  if (!(CONSENT_API_TARGETS as readonly string[]).includes(next)) {
    return {
      code: "invalid_target",
      detail: `Target consent state '${next}' is not addressable through the consent API. Allowed: ${CONSENT_API_TARGETS.join(", ")}.`,
    };
  }
  return null;
}

/**
 * Who is asking for the body. Reserved for future use — a provider
 * session might see its own body under `granted` but nothing under
 * `pending`, while a staff session gets the same treatment because
 * `pending` means we haven't gathered consent yet. For v0 the rules
 * are the same across actors; we keep the parameter so later gates
 * (legal-hold flags, provider-authored redactions) don't change the
 * call-sites.
 */
export interface ActorContext {
  workspaceId: string;
  /** Kind of session calling the helper; informational for v0. */
  actorKind?: "staff" | "provider" | "system";
}

export interface ConversationBodyRow {
  id: string;
  workspaceId: string;
  consentState: string;
  body: string | null;
  summary: string | null;
  occurredAt: Date;
  channel: string;
}

/**
 * Read the body of a conversation, honoring consent. Returns `null`
 * (not undefined) when the row exists but its consent state hides the
 * body; returns the row-less result when the id is unknown or not
 * accessible to the actor's workspace.
 *
 * This is the one chokepoint for body reads — callers outside the
 * extract pipeline should route through it so a future "legal hold"
 * or "under subpoena" flag only needs to land in one place.
 */
export async function getConversationBody(
  conversationId: string,
  actor: ActorContext,
): Promise<{ row: ConversationBodyRow; body: string | null } | null> {
  const rows = await db()
    .select({
      id: signalConversations.id,
      workspaceId: signalConversations.workspaceId,
      consentState: signalConversations.consentState,
      body: signalConversations.body,
      summary: signalConversations.summary,
      occurredAt: signalConversations.occurredAt,
      channel: signalConversations.channel,
    })
    .from(signalConversations)
    .where(
      and(
        eq(signalConversations.id, conversationId),
        eq(signalConversations.workspaceId, actor.workspaceId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const body = isBodyVisible(row.consentState) ? (row.body ?? null) : null;
  return { row, body };
}

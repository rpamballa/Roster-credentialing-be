/**
 * `roster-internal` · case-notes reader
 * -------------------------------------
 *
 * Reads Roster's own `case_notes` table — the recruiter-authored
 * commentary attached to a credentialing case — and yields it as
 * `signal_conversations` rows with channel `case_note`.
 *
 * Why these surface in Signal at all: the ranker wants to see what
 * the recruiter has already learned about a provider (region
 * preference mentioned in a note, "has family in TX, wants to stay
 * close", a rate the provider floated, "won't work OB cases"). The
 * extracts pipeline (WS E) then lifts those facets out of the note
 * body the same way it does out of an outbound email.
 *
 * Consent: case notes are internal recruiter writing, not
 * provider-authored content. We stamp them `implied_outbound` — the
 * same rationale we use for outbound emails: it's content WE wrote,
 * so no provider consent is required. Treating them as outbound also
 * makes the ranker + extractor pipelines read them by default
 * without any consent-API ceremony per note.
 *
 * Soft-deleted rows (`deleted_at IS NOT NULL`) are skipped — the
 * spec on the credentialing side explicitly retains them for audit
 * but hides them in the UI, and we follow the same convention here.
 *
 * Provider resolution: a case note has no direct recipient. We walk
 * `case_notes.case_id → cases.provider_id → providers` to find the
 * NPI/email/phone identity the runner needs for ER. If the case is
 * orphaned (shouldn't happen — FK is NOT NULL) the row is dropped;
 * the runner's summary surfaces it via the generic reader-error path.
 */

import { db } from "@cred/db";
import { caseNotes, cases, providers } from "@cred/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { ConversationRecord, ReaderContext } from "../adapters/types.js";
import { ROSTER_INTERNAL_SYSTEM } from "./providers.js";

export async function readCaseNotes(ctx: ReaderContext): Promise<ConversationRecord[]> {
  const rows = await db()
    .select({
      noteId: caseNotes.id,
      caseId: caseNotes.caseId,
      body: caseNotes.body,
      createdAt: caseNotes.createdAt,
      providerFirstName: providers.firstName,
      providerLastName: providers.lastName,
      providerNpi: providers.npi,
      providerEmail: providers.email,
      providerPhone: providers.phone,
    })
    .from(caseNotes)
    .innerJoin(cases, eq(cases.id, caseNotes.caseId))
    .innerJoin(providers, eq(providers.id, cases.providerId))
    .where(and(eq(caseNotes.workspaceId, ctx.workspaceId), isNull(caseNotes.deletedAt)));

  return rows.map((r): ConversationRecord => {
    const identity: NonNullable<ConversationRecord["providerIdentity"]> = {
      name: `${r.providerFirstName} ${r.providerLastName}`.trim(),
    };
    if (r.providerNpi) identity.npi = r.providerNpi;
    if (r.providerEmail) identity.email = r.providerEmail;
    if (r.providerPhone) identity.phone = r.providerPhone;

    const body = r.body ?? "";
    const summary = body.slice(0, 280);

    const record: ConversationRecord = {
      providerIdentity: identity,
      channel: "case_note",
      occurredAt: r.createdAt,
      consentState: "implied_outbound",
      sourceRef: {
        system: "case_notes",
        noteId: r.noteId,
        caseId: r.caseId,
      },
      source: {
        externalSystem: ROSTER_INTERNAL_SYSTEM,
        externalId: `case_notes:${r.noteId}`,
      },
    };
    if (summary) record.summary = summary;
    if (body) record.body = body;
    return record;
  });
}

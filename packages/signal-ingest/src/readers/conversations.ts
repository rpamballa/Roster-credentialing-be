/**
 * `roster-internal` · conversations reader
 * ----------------------------------------
 *
 * Reads outbound recruiter→provider email history and yields it as
 * `signal_conversations` rows. We use the existing `outreach_messages`
 * table (`channel="email"`, `direction="out"`) — that IS Roster's
 * outbound email log. Joined to `outreach_threads` for recipient
 * identity, and to `cases` → `providers` to recover provider identity
 * for entity resolution.
 *
 * `consent_state` is set to `"implied_outbound"` because these are
 * outbound touches to a candidate the recruiter is already working
 * with via a case — the agency's own contact. Inbound replies (which
 * require explicit opt-in handling) are NOT read in v0.
 *
 * If no outbound emails exist for the workspace, this reader returns
 * zero rows. We surface that explicitly through the runner summary's
 * gap list ("no outbound email history found"); the runner itself
 * does not fail.
 */

import { db } from "@cred/db";
import { cases, outreachMessages, outreachThreads, providers } from "@cred/db/schema";
import { and, eq } from "drizzle-orm";
import type { ConversationRecord, ReaderContext } from "../adapters/types.js";
import { ROSTER_INTERNAL_SYSTEM } from "./providers.js";

export async function readConversations(ctx: ReaderContext): Promise<ConversationRecord[]> {
  const rows = await db()
    .select({
      messageId: outreachMessages.id,
      channel: outreachMessages.channel,
      direction: outreachMessages.direction,
      body: outreachMessages.body,
      sentAt: outreachMessages.sentAt,
      scheduledAt: outreachMessages.scheduledAt,
      threadId: outreachThreads.id,
      recipientKind: outreachThreads.recipientKind,
      recipientEmail: outreachThreads.recipientEmail,
      recipientPhone: outreachThreads.recipientPhone,
      recipientName: outreachThreads.recipientName,
      providerFirstName: providers.firstName,
      providerLastName: providers.lastName,
      providerNpi: providers.npi,
      providerEmail: providers.email,
      providerPhone: providers.phone,
    })
    .from(outreachMessages)
    .innerJoin(outreachThreads, eq(outreachThreads.id, outreachMessages.threadId))
    .innerJoin(cases, eq(cases.id, outreachThreads.caseId))
    .innerJoin(providers, eq(providers.id, cases.providerId))
    .where(
      and(
        eq(outreachMessages.workspaceId, ctx.workspaceId),
        eq(outreachMessages.direction, "out"),
        eq(outreachMessages.channel, "email"),
      ),
    );

  return rows.map((r): ConversationRecord => {
    // Prefer the thread's recipient email over the provider record
    // for identity matching — it's what the message was actually
    // sent to and matches lineage best.
    const identityName =
      r.recipientKind === "provider" && r.recipientName
        ? r.recipientName
        : `${r.providerFirstName} ${r.providerLastName}`.trim();
    const identityEmail =
      r.recipientKind === "provider" && r.recipientEmail
        ? r.recipientEmail
        : (r.providerEmail ?? undefined);
    const identityPhone =
      r.recipientKind === "provider" && r.recipientPhone
        ? r.recipientPhone
        : (r.providerPhone ?? undefined);

    const providerIdentity: NonNullable<ConversationRecord["providerIdentity"]> = {
      name: identityName,
    };
    if (r.providerNpi) providerIdentity.npi = r.providerNpi;
    if (identityEmail) providerIdentity.email = identityEmail;
    if (identityPhone) providerIdentity.phone = identityPhone;

    // sentAt is the right occurred-at; fall back to scheduledAt for
    // messages that were queued but not yet sent (still recorded).
    const occurredAt = r.sentAt ?? r.scheduledAt ?? new Date();

    const summary = (r.body ?? "").slice(0, 280);

    const record: ConversationRecord = {
      providerIdentity,
      channel: "email",
      occurredAt,
      consentState: "implied_outbound",
      sourceRef: {
        system: "outreach_messages",
        messageId: r.messageId,
        threadId: r.threadId,
      },
      source: {
        externalSystem: ROSTER_INTERNAL_SYSTEM,
        externalId: `outreach_messages:${r.messageId}`,
      },
    };
    if (summary) record.summary = summary;
    return record;
  });
}

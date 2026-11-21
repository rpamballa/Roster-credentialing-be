/**
 * The `roster-internal` adapter — Signal's v0 single data source.
 *
 * Reading Roster's own tables and shaping them as `SignalIngestAdapter`
 * rows is the whole point of v0 ingest: the runner treats this
 * adapter exactly like any future external adapter, so the day a
 * real external ATS comes online nothing in the runner changes.
 */

import type { ConversationRecord, ReaderContext, SignalIngestAdapter } from "../adapters/types.js";
import { readCaseNotes } from "./caseNotes.js";
import { readConversations as readOutboundEmails } from "./conversations.js";
import { readCredentials } from "./credentials.js";
import { readFacilities } from "./facilities.js";
import { readJobs } from "./jobs.js";
import { ROSTER_INTERNAL_SYSTEM, readProviders } from "./providers.js";

export { readProviders, ROSTER_INTERNAL_SYSTEM } from "./providers.js";
export { readJobs, countCases } from "./jobs.js";
export { readFacilities, validateFacilityReferences } from "./facilities.js";
export { readCredentials } from "./credentials.js";
export { readConversations as readOutboundEmails } from "./conversations.js";
export { readCaseNotes } from "./caseNotes.js";

/**
 * The adapter's `readConversations` returns outbound emails + case
 * notes concatenated. We fan the two sources into a single reader
 * surface so the runner's reader-slot count stays at five; the
 * runner's idempotency, lineage-recording, and summary accounting
 * all work on the flat list without special-casing case notes.
 */
async function readConversations(ctx: ReaderContext): Promise<ConversationRecord[]> {
  const [emails, notes] = await Promise.all([readOutboundEmails(ctx), readCaseNotes(ctx)]);
  return [...emails, ...notes];
}

export { readConversations };

export const rosterInternalAdapter: SignalIngestAdapter = {
  name: ROSTER_INTERNAL_SYSTEM,
  readProviders,
  readJobs,
  readFacilities,
  readCredentials,
  readConversations,
};

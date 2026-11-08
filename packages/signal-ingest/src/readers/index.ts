/**
 * The `roster-internal` adapter — Signal's v0 single data source.
 *
 * Reading Roster's own tables and shaping them as `SignalIngestAdapter`
 * rows is the whole point of v0 ingest: the runner treats this
 * adapter exactly like any future external adapter, so the day a
 * real external ATS comes online nothing in the runner changes.
 */

import type { SignalIngestAdapter } from "../adapters/types.js";
import { readConversations } from "./conversations.js";
import { readCredentials } from "./credentials.js";
import { readFacilities } from "./facilities.js";
import { readJobs } from "./jobs.js";
import { ROSTER_INTERNAL_SYSTEM, readProviders } from "./providers.js";

export { readProviders, ROSTER_INTERNAL_SYSTEM } from "./providers.js";
export { readJobs, countCases } from "./jobs.js";
export { readFacilities, validateFacilityReferences } from "./facilities.js";
export { readCredentials } from "./credentials.js";
export { readConversations } from "./conversations.js";

export const rosterInternalAdapter: SignalIngestAdapter = {
  name: ROSTER_INTERNAL_SYSTEM,
  readProviders,
  readJobs,
  readFacilities,
  readCredentials,
  readConversations,
};

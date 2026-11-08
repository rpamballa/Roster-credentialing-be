/**
 * `@cred/signal-ingest` — Signal's connector plane.
 *
 * For v0 the only wired adapter is `roster-internal` (readers in
 * `./readers/*.ts`). External adapters (Bullhorn, Twilio, Resend-in,
 * etc.) are designed as the `SignalIngestAdapter` interface in
 * `./adapters/types.ts` and ship in v1.
 *
 * Library-only: this package exposes no HTTP routes. WS A (the Hono
 * surface) is the integration point.
 */

export * from "./adapters/types.js";
export {
  ROSTER_INTERNAL_SYSTEM,
  countCases,
  readCaseNotes,
  readConversations,
  readCredentials,
  readFacilities,
  readJobs,
  readOutboundEmails,
  readProviders,
  rosterInternalAdapter,
  validateFacilityReferences,
} from "./readers/index.js";
export {
  type IngestGap,
  type IngestSummary,
  type ReaderError,
  type RunIngestOnceOptions,
  runIngestOnce,
} from "./runner.js";
export {
  type CredentialGapKind,
  type EnumerateCredentialGapsArgs,
  type ProviderCredentialGap,
  enumerateCredentialGaps,
} from "./gaps.js";

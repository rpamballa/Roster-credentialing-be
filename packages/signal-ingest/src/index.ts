/**
 * `@cred/signal-ingest` — Signal's connector plane.
 *
 * The legacy readers (in `./readers/*.ts`) remain the reference
 * implementation backing the `roster-internal` adapter. The new
 * ingestion framework below layers an adapter contract + a scheduler
 * on top of that implementation so external vendors (Bullhorn,
 * Twilio, Gmail, …) slot in without the runner learning new shapes.
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
  rosterInternalAdapter as rosterInternalReaders,
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

// ─── Ingestion framework (adapter contract + scheduler) ────────────
//
// Keep these exports distinct from the legacy readers above. The
// legacy readers remain the reference impl backing the new
// `roster-internal` adapter; everything that writes to signal_* goes
// through the runner. The framework exports below are what WS H's
// scheduler, routes, and tests consume.
export {
  type AdapterBackfillResult,
  type AdapterCapability,
  type AdapterContext,
  type AdapterContract,
  type AdapterHealth,
  type AdapterLogger,
  type AdapterPreview,
  type AdapterSyncResult,
  NotImplementedForOnboarding,
} from "./adapters/contract.js";
export { ROSTER_INTERNAL, rosterInternalAdapter } from "./adapters/rosterInternal.js";
export {
  type AdapterRegistry,
  UnknownAdapterError,
  createRegistry,
  defaultAdapterRegistry,
  getAdapter,
} from "./adapters/registry.js";
export {
  type AdapterHealthReport,
  type DbBreakerState,
  type HealthOptions,
  type PreviewOptions,
  type PreviewResult,
  type ResetStateOptions,
  type RunAllDueOptions,
  type RunOnceOptions,
  type RunOnceResult,
  BreakerOpenInDbError,
  DB_BREAKER_TRIP_AT,
  adapterHealth,
  preview,
  resetAdapterState,
  runAllDue,
  runOnce,
} from "./scheduler.js";

// ─── Agency onboarding (declarative config → applied state) ────────
//
// `scripts/signal-onboard.ts` is the only consumer today. Exposing
// the schema + credential resolver here keeps the FE BFF and any
// future onboarding wizard able to validate files before writing them.
export {
  type AdapterConfig,
  type AgencyConfig,
  type ConfigEntry,
  type CredentialSource,
  type KnowledgeDocConfig,
  type OnboardingGapConfig,
  type ResolveOptions,
  type SpecialistConfig,
  AgencyConfigError,
  CredentialResolutionError,
  adapterConfigSchema,
  agencyConfigSchema,
  configEntrySchema,
  credentialSourceSchema,
  knowledgeDocSchema,
  onboardingGapSchema,
  parseAgencyConfig,
  resolveCredentials,
  specialistSchema,
} from "./onboarding/index.js";

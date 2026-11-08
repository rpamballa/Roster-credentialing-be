/**
 * `@cred/signal-extracts` — Signal's facet-extraction pipeline.
 *
 * Pure extractor + database-aware runner. Bodies live in
 * `signal_conversations.body`; this package reads them under consent
 * rules, extracts five v0 facets (REGION_PREFERENCE, TIMING_WINDOW,
 * RATE_EXPECTATION, SUBSPECIALTY_INTEREST, AVAILABILITY_SIGNAL) and
 * upserts them into `signal_extracts` idempotently.
 *
 * Library-only: no HTTP routes. WS A's Hono surface and the ingest
 * runner (in `@cred/signal-ingest`) are the integration points.
 */

export {
  type Extract,
  type Facet,
  type SourceSpan,
  FACETS,
  extract,
} from "./extract.js";
export {
  type RunExtractsOptions,
  type RunExtractsSummary,
  runExtracts,
} from "./runner.js";
export {
  type VisibleExtract,
  extractsForConversations,
  extractsForWorkspace,
} from "./query.js";

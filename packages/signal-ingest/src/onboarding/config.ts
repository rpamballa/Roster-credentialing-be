/**
 * Agency onboarding — declarative config shape.
 *
 * One JSON file per agency captures everything Signal needs to light
 * up ingestion for that workspace: identity + specialists + config KV
 * + knowledge seeds + per-adapter credentials + which adapters to run
 * on first bootstrap + onboarding gaps to pre-open.
 *
 * The `scripts/signal-onboard.ts` runner reads this file and applies
 * it idempotently. Re-running against the same file converges, so the
 * JSON is the source of truth: edit it, re-run, inspect the diff.
 *
 * Schema invariants worth calling out:
 *   • `adapter` keys inside `adapters: { ... }` must exist in
 *     `defaultAdapterRegistry` — the runner cross-checks and refuses
 *     unknown names up front (no silent typos).
 *   • `credentials` takes a *source* descriptor, not raw secrets.
 *     Inline values are allowed for dev but trip a warning when
 *     `NODE_ENV === "production"`.
 *   • The config is authoritative, not additive: the runner upserts
 *     every row described here and opens a gap for every stub adapter
 *     listed. Rows outside the config are left alone (we never
 *     cross-delete) — if you want to retire a value, remove it from
 *     the file AND clear it via the ordinary API.
 */

import { z } from "zod";

// ─── Credential sources ────────────────────────────────────────────
// Where the adapter credentials live. The runner resolves these down
// to a `Record<string, string>` immediately before calling
// `encryptCredential`, which never sees the source.

const credentialSourceEnv = z.object({
  source: z.literal("env"),
  /**
   * Map from logical credential name (what the adapter expects, e.g.
   * `clientId`) to the environment variable that holds the value.
   */
  map: z.record(z.string().min(1)),
});

const credentialSourceInline = z.object({
  source: z.literal("inline"),
  /**
   * Literal credential bag. Dev-only path; the runner refuses to
   * encrypt an inline bag when `NODE_ENV === "production"` unless
   * `--allow-inline-in-prod` is passed. Prefer `env` or `file` for
   * anything real.
   */
  values: z.record(z.string()),
});

const credentialSourceFile = z.object({
  source: z.literal("file"),
  /**
   * Absolute path to a JSON file containing a flat object of
   * credentials. The runner reads + parses on apply and the file
   * never leaves the host.
   */
  path: z.string().min(1),
});

export const credentialSourceSchema = z.discriminatedUnion("source", [
  credentialSourceEnv,
  credentialSourceInline,
  credentialSourceFile,
]);

export type CredentialSource = z.infer<typeof credentialSourceSchema>;

// ─── Per-adapter config entry ──────────────────────────────────────

export const adapterConfigSchema = z.object({
  /**
   * When false, the runner skips every write for this adapter but
   * still opens the gap row (so CS can see it on the health view).
   * The adapter itself still enumerates for the health dashboard.
   */
  enabled: z.boolean(),
  /**
   * Optional override of the adapter's built-in cadence (ms). The
   * scheduler honors this on the next tick.
   */
  cadenceMsOverride: z.number().int().positive().optional(),
  /**
   * Credentials source — required when `enabled: true`, forbidden
   * when `enabled: false`. The runner enforces at apply time.
   */
  credentials: credentialSourceSchema.optional(),
  /**
   * Opaque config the adapter reads alongside its credentials (base
   * URLs, OAuth tenant ids, "which user's mailbox", etc). Stored as
   * a `signal_workspace_config` row under scope `adapter.<name>`.
   */
  config: z.record(z.unknown()).optional(),
  /**
   * What to do on this apply run. Default: preview only (no writes).
   * Gives CS a way to prove the creds resolve before committing to
   * a full sync.
   */
  runOnBootstrap: z
    .object({
      preview: z.boolean().default(true),
      sync: z.boolean().default(false),
    })
    .default({ preview: true, sync: false }),
});

export type AdapterConfig = z.infer<typeof adapterConfigSchema>;

// ─── Specialists (recruiters) ──────────────────────────────────────

export const specialistSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["owner", "admin", "specialist", "viewer"]).default("specialist"),
});

export type SpecialistConfig = z.infer<typeof specialistSchema>;

// ─── Knowledge seeds ───────────────────────────────────────────────

export const knowledgeDocSchema = z.object({
  /** Human-readable title — also used for idempotency on re-apply. */
  title: z.string().min(1),
  bodyMarkdown: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
});

export type KnowledgeDocConfig = z.infer<typeof knowledgeDocSchema>;

// ─── Config KV ─────────────────────────────────────────────────────

export const configEntrySchema = z.object({
  scope: z.string().min(1),
  key: z.string().min(1),
  value: z.unknown(),
});

export type ConfigEntry = z.infer<typeof configEntrySchema>;

// ─── Pre-opened onboarding gaps ────────────────────────────────────

export const onboardingGapSchema = z.object({
  title: z.string().min(1),
  bodyMarkdown: z.string().min(1),
  status: z.enum(["open", "planned", "wontfix", "resolved"]).default("open"),
});

export type OnboardingGapConfig = z.infer<typeof onboardingGapSchema>;

// ─── Agency root ───────────────────────────────────────────────────

export const agencyConfigSchema = z.object({
  /**
   * Pinned schema version. Bump when a breaking change lands so a
   * stale config file fails loud instead of silently skipping a new
   * section.
   */
  schemaVersion: z.literal(1),

  agency: z.object({
    /**
     * URL-safe slug — also `workspaces.slug`. Must be stable; the
     * runner looks up the workspace by this.
     */
    slug: z
      .string()
      .min(2)
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "lowercase kebab-case, no leading/trailing dashes"),
    name: z.string().min(1),
    type: z.enum(["agency", "hospital", "solo_provider"]).default("agency"),
    signalEnabled: z.boolean().default(true),
  }),

  specialists: z.array(specialistSchema).default([]),
  config: z.array(configEntrySchema).default([]),
  knowledge: z.array(knowledgeDocSchema).default([]),
  adapters: z.record(adapterConfigSchema).default({}),
  gaps: z.array(onboardingGapSchema).default([]),
});

export type AgencyConfig = z.infer<typeof agencyConfigSchema>;

// ─── Parsing ───────────────────────────────────────────────────────

export class AgencyConfigError extends Error {
  readonly issues: z.ZodIssue[];
  constructor(message: string, issues: z.ZodIssue[]) {
    super(message);
    this.name = "AgencyConfigError";
    this.issues = issues;
  }
}

/**
 * Parse + validate a raw JSON blob. Throws `AgencyConfigError` with
 * the full zod issue list on bad input.
 */
export function parseAgencyConfig(input: unknown): AgencyConfig {
  const parsed = agencyConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgencyConfigError("invalid agency config", parsed.error.issues);
  }
  const cfg = parsed.data;

  // Cross-field: an enabled adapter needs credentials; a disabled one
  // must not carry them. Zod cannot express this in the record
  // discriminator without a refine on every entry, so the check lives
  // here, after parse.
  const adapters: Record<string, AdapterConfig> = cfg.adapters;
  for (const [adapter, entry] of Object.entries(adapters)) {
    if (entry.enabled && !entry.credentials) {
      throw new AgencyConfigError(`adapter '${adapter}' is enabled but has no credentials`, []);
    }
    if (!entry.enabled && entry.credentials) {
      throw new AgencyConfigError(
        `adapter '${adapter}' is disabled but still carries credentials`,
        [],
      );
    }
  }

  return cfg;
}

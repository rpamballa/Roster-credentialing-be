/**
 * Adapter between Signal's canonical tables and the credential bridge.
 *
 * `@cred/signal-cred-bridge` wants a `ProviderCredentialState` struct
 * covering licenses, DEA, CSR, board cert, ACLS, immunizations,
 * background check, drug screen, and sub-specialties. Signal stores
 * these flat per `signal_credentials` row — one per credential type.
 * This adapter folds those rows up into the struct the bridge expects.
 *
 * Why it lives in `signal-match` and not the bridge: the bridge is
 * intentionally pure (no DB types, no Signal types). The adapter is
 * the glue that knows about `signal_providers.specialties` and the
 * `type` column on `signal_credentials`, so it belongs on the ranker
 * side of the seam.
 */

import type { signalCredentials, signalJobs, signalProviders } from "@cred/db/schema";
import type {
  FacilityRequirements,
  ProviderCredentialState,
  RequiredCredential,
  SubSpecialty,
} from "@cred/signal-cred-bridge";

type SignalCredentialRow = typeof signalCredentials.$inferSelect;
type SignalJobRow = typeof signalJobs.$inferSelect;
type SignalProviderRow = typeof signalProviders.$inferSelect;

// Known sub-specialties the bridge speaks today. Anything else (e.g.
// a workspace's custom tag) is dropped on the floor rather than
// forced into "general" — the bridge's confidence scoring catches a
// mismatch downstream.
const KNOWN_SUBSPECIALTIES: ReadonlySet<SubSpecialty> = new Set([
  "cardiac",
  "ob",
  "pediatric",
  "pain",
  "general",
]);

function normalizeSubSpecialty(raw: string): SubSpecialty | undefined {
  const v = raw.trim().toLowerCase();
  if (KNOWN_SUBSPECIALTIES.has(v as SubSpecialty)) return v as SubSpecialty;
  return undefined;
}

/** Project a provider's specialties array into bridge-known tags. */
export function providerSubSpecialties(provider: SignalProviderRow): SubSpecialty[] {
  const out: SubSpecialty[] = [];
  for (const raw of provider.specialties) {
    const normalized = normalizeSubSpecialty(raw);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * Build a `ProviderCredentialState` from a provider's credential rows.
 * We're liberal about missing data — anything we can't find falls
 * back to the `"none"` / `invalid` / `"flagged"=false` defaults the
 * bridge expects. The bridge's confidence scoring will mark the
 * projection as `low` when inputs look sparse.
 */
export function buildCredentialState(
  provider: SignalProviderRow,
  credentials: readonly SignalCredentialRow[],
): ProviderCredentialState {
  const licenses: ProviderCredentialState["licenses"] = [];
  const stateCsr: ProviderCredentialState["stateCsr"] = [];
  let dea: ProviderCredentialState["dea"] = { status: "none" };
  let boardCert: ProviderCredentialState["boardCert"] = { status: "none", board: null };
  let acls: ProviderCredentialState["acls"] = { valid: false };
  let immunizations: ProviderCredentialState["immunizations"] = { complete: false };
  let backgroundCheck: ProviderCredentialState["backgroundCheck"] = { status: "none" };
  let drugScreen: ProviderCredentialState["drugScreen"] = { status: "none" };
  let imlcEligible = false;

  for (const row of credentials) {
    const type = row.type.trim().toLowerCase();
    const status = (row.status ?? "none").trim().toLowerCase();
    // Drizzle's `date` columns return ISO strings here (no `mode:
    // "date"` on the schema). The bridge only consults `status`, not
    // the expiry date, so we parse these lazily and don't fail the
    // projection on a malformed string.
    const expiresDate = parseDateColumn(row.expires);
    switch (type) {
      case "state_license":
      case "license": {
        if (row.state) {
          const entry: ProviderCredentialState["licenses"][number] = {
            state: row.state,
            status: coerceCredentialStatus(status),
          };
          if (expiresDate) entry.expires = expiresDate;
          licenses.push(entry);
        }
        break;
      }
      case "imlc":
        imlcEligible = status === "active" || status === "eligible";
        break;
      case "dea":
        dea = {
          status: coerceCredentialStatus(status),
          ...(expiresDate ? { expires: expiresDate } : {}),
        };
        break;
      case "state_csr":
      case "csr":
        if (row.state) {
          stateCsr.push({ state: row.state, status: coerceCredentialStatus(status) });
        }
        break;
      case "board_cert":
      case "board":
        boardCert = {
          status: status === "certified" ? "certified" : status === "lapsed" ? "lapsed" : "none",
          board: null,
        };
        break;
      case "acls":
        acls = {
          valid: status === "active" || status === "valid",
          ...(expiresDate ? { expires: expiresDate } : {}),
        };
        break;
      case "immunizations":
        immunizations = { complete: status === "complete" || status === "active" };
        break;
      case "background_check":
      case "bg":
        backgroundCheck = { status: coerceScreeningStatus(status) };
        break;
      case "drug_screen":
      case "drug":
        drugScreen = { status: coerceScreeningStatus(status) };
        break;
      // `facility_privileges` is derived from facility settings, not a
      // provider-side credential; ignore if the ingest put one here.
    }
  }

  return {
    specialties: providerSubSpecialties(provider),
    licenses,
    imlcEligible,
    dea,
    stateCsr,
    boardCert,
    acls,
    immunizations,
    backgroundCheck,
    drugScreen,
  };
}

function parseDateColumn(raw: unknown): Date | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? undefined : raw;
  if (typeof raw === "string") {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function coerceCredentialStatus(s: string): "active" | "pending" | "expired" | "none" {
  if (s === "active") return "active";
  if (s === "pending") return "pending";
  if (s === "expired") return "expired";
  return "none";
}

function coerceScreeningStatus(s: string): "clear" | "pending" | "flagged" | "none" {
  if (s === "clear") return "clear";
  if (s === "pending") return "pending";
  if (s === "flagged") return "flagged";
  return "none";
}

/**
 * Derive `FacilityRequirements` from a Signal job row. Signal's `jobs`
 * table carries facility pointer + specialty + state but not the
 * detailed credentialing-cycle numbers the bridge needs — we fall
 * back to sensible, documented defaults for the anesthesiology-locum
 * pilot. A later workstream can fetch facility-specific overrides.
 *
 * `requiredSubSpecialty`: inferred from the job's specialty string;
 * falls back to "general" so a job that just says "anesthesiology"
 * still projects cleanly.
 *
 * `requiredCredentials`: the standard locum anesthesia set. `state`:
 * from the job row, uppercased; empty when missing (no valid state =
 * no state-license projection will succeed, which is the right fail
 * mode).
 */
export function buildFacilityRequirements(job: SignalJobRow): FacilityRequirements {
  const specialtySub = normalizeSubSpecialty(job.specialty);
  const requiredSubSpecialty: SubSpecialty = specialtySub ?? "general";
  const state = (job.state ?? "").trim().toUpperCase();
  const requiredCredentials: RequiredCredential[] = [
    "state_license",
    "dea",
    "state_csr",
    "board_cert",
    "acls",
    "immunizations",
    "background_check",
    "drug_screen",
    "facility_privileges",
  ];
  return {
    state,
    requiredSubSpecialty,
    requiredCredentials,
    // Industry-standard defaults for the pilot.
    privilegingCycleDays: 90,
    supportsTemporaryPrivileges: true,
    tempPrivilegingDays: 14,
    // IMLC compact membership varies by state. For v0 we assume true
    // when the state is non-empty and in the compact list — see
    // IMLC_COMPACT_STATES.
    isImlcCompactState: IMLC_COMPACT_STATES.has(state),
  };
}

// As of late 2025. Not exhaustive — kept as data so a workspace that
// cares can hoist this list into a settings row later.
const IMLC_COMPACT_STATES: ReadonlySet<string> = new Set([
  "AL",
  "AZ",
  "CO",
  "DE",
  "GA",
  "IA",
  "ID",
  "IL",
  "KS",
  "KY",
  "ME",
  "MD",
  "MI",
  "MN",
  "MS",
  "MT",
  "NE",
  "NH",
  "NV",
  "ND",
  "OH",
  "OK",
  "PA",
  "SD",
  "TN",
  "UT",
  "VT",
  "WA",
  "WI",
  "WV",
  "WY",
]);

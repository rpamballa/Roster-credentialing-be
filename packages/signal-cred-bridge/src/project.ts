/**
 * Signal · Credentialing Bridge · earliest-start projection
 * ---------------------------------------------------------
 * Pure library. No DB, no network. Given a provider's credential state and a
 * facility's requirements, project the earliest date the provider could
 * realistically start THIS job at THIS facility, and name the binding
 * credential.
 *
 * Mode A (v0): credential state is read from Roster's own DB by the caller
 * and passed in. Mode B (v1) will read ATS custom fields — see `mode-b-stub.ts`.
 */

export type SubSpecialty = "cardiac" | "ob" | "pediatric" | "pain" | "general";
export type Confidence = "high" | "medium" | "low";

export type CredentialStatus = "active" | "pending" | "expired" | "none";
export type ScreeningStatus = "clear" | "pending" | "flagged" | "none";
export type BoardCertStatus = "certified" | "lapsed" | "none";
export type Board = "ABA" | "AOBA" | null;

export type RequiredCredential =
  | "state_license"
  | "dea"
  | "state_csr"
  | "board_cert"
  | "acls"
  | "immunizations"
  | "background_check"
  | "drug_screen"
  | "facility_privileges";

export interface ProviderCredentialState {
  specialties: SubSpecialty[];
  licenses: Array<{ state: string; status: CredentialStatus; expires?: Date }>;
  imlcEligible: boolean;
  dea: { status: CredentialStatus; expires?: Date };
  stateCsr: Array<{ state: string; status: CredentialStatus }>;
  boardCert: { status: BoardCertStatus; board: Board };
  acls: { valid: boolean; expires?: Date };
  immunizations: { complete: boolean };
  backgroundCheck: { status: ScreeningStatus; completedAt?: Date };
  drugScreen: { status: ScreeningStatus };
}

export interface FacilityRequirements {
  state: string;
  requiredSubSpecialty: SubSpecialty;
  requiredCredentials: RequiredCredential[];
  /** Typical 60–120 days. */
  privilegingCycleDays: number;
  supportsTemporaryPrivileges: boolean;
  /** Typical ~14 days when supported. */
  tempPrivilegingDays?: number;
  isImlcCompactState: boolean;
}

export interface ProjectionInput {
  today: Date;
  provider: ProviderCredentialState;
  facility: FacilityRequirements;
}

export interface CredentialReadiness {
  credential: string;
  readyDate: Date;
  isBinding: boolean;
  notes?: string;
}

export interface ProjectionResult {
  earliestStartDate: Date;
  confidence: Confidence;
  bindingCredential: string;
  breakdown: CredentialReadiness[];
}

/**
 * Deterministic credential order. Used both to sort the breakdown and to break
 * ties when two credentials share the same readyDate.
 */
const CREDENTIAL_ORDER: readonly RequiredCredential[] = [
  "state_license",
  "dea",
  "state_csr",
  "board_cert",
  "acls",
  "immunizations",
  "background_check",
  "drug_screen",
  "facility_privileges",
] as const;

// Day-offset constants — single source of truth so tests can assert them.
const DAYS_IMLC_COMPACT_LICENSE = 30;
const DAYS_NEW_STATE_LICENSE = 90;
const DAYS_DEA_RENEW = 60;
const DAYS_STATE_CSR = 45;
const DAYS_BOARD_CERT = 365;
const DAYS_ACLS = 7;
const DAYS_IMMUNIZATIONS = 14;
const DAYS_BG_PENDING = 14;
const DAYS_BG_NEW = 21;
const DAYS_DRUG_SCREEN = 7;
const DAYS_DEFAULT_TEMP_PRIVILEGES = 14;
/** Flagged inputs push the projection to this many days out. Treated as "never" for practical scheduling. */
const DAYS_FAR_FUTURE = 10 * 365;

const MS_PER_DAY = 86_400_000;

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * MS_PER_DAY);
}

function hasActiveLicenseInState(
  licenses: ProviderCredentialState["licenses"],
  state: string,
): boolean {
  return licenses.some((l) => l.state === state && l.status === "active");
}

function hasActiveCsrInState(csrs: ProviderCredentialState["stateCsr"], state: string): boolean {
  return csrs.some((c) => c.state === state && c.status === "active");
}

/**
 * Compute the earliest readiness date for a single required credential.
 * Returns the raw ready date; confidence weighting is handled at the top level.
 */
function readyDateFor(
  credential: RequiredCredential,
  input: ProjectionInput,
): { readyDate: Date; notes?: string } {
  const { today, provider, facility } = input;

  switch (credential) {
    case "state_license": {
      if (hasActiveLicenseInState(provider.licenses, facility.state)) {
        return { readyDate: addDays(today, 0), notes: `active ${facility.state} license on file` };
      }
      if (provider.imlcEligible && facility.isImlcCompactState) {
        return {
          readyDate: addDays(today, DAYS_IMLC_COMPACT_LICENSE),
          notes: `IMLC compact issuance (~${DAYS_IMLC_COMPACT_LICENSE}d)`,
        };
      }
      return {
        readyDate: addDays(today, DAYS_NEW_STATE_LICENSE),
        notes: `new ${facility.state} state license (~${DAYS_NEW_STATE_LICENSE}d)`,
      };
    }

    case "dea": {
      if (provider.dea.status === "active") {
        return { readyDate: addDays(today, 0), notes: "active DEA on file" };
      }
      return {
        readyDate: addDays(today, DAYS_DEA_RENEW),
        notes: `DEA ${provider.dea.status} → renewal (~${DAYS_DEA_RENEW}d)`,
      };
    }

    case "state_csr": {
      if (hasActiveCsrInState(provider.stateCsr, facility.state)) {
        return { readyDate: addDays(today, 0), notes: `active ${facility.state} CSR on file` };
      }
      return {
        readyDate: addDays(today, DAYS_STATE_CSR),
        notes: `new ${facility.state} CSR (~${DAYS_STATE_CSR}d)`,
      };
    }

    case "board_cert": {
      if (provider.boardCert.status === "certified") {
        return { readyDate: addDays(today, 0), notes: "board certified" };
      }
      return {
        readyDate: addDays(today, DAYS_BOARD_CERT),
        notes: `board cert ${provider.boardCert.status} → re-cert cycle (~${DAYS_BOARD_CERT}d)`,
      };
    }

    case "acls": {
      if (provider.acls.valid) {
        return { readyDate: addDays(today, 0), notes: "ACLS valid" };
      }
      return {
        readyDate: addDays(today, DAYS_ACLS),
        notes: `ACLS course + card (~${DAYS_ACLS}d)`,
      };
    }

    case "immunizations": {
      if (provider.immunizations.complete) {
        return { readyDate: addDays(today, 0), notes: "immunizations complete" };
      }
      return {
        readyDate: addDays(today, DAYS_IMMUNIZATIONS),
        notes: `complete immunizations (~${DAYS_IMMUNIZATIONS}d)`,
      };
    }

    case "background_check": {
      const status = provider.backgroundCheck.status;
      if (status === "clear") {
        return { readyDate: addDays(today, 0), notes: "background check clear" };
      }
      if (status === "pending") {
        return {
          readyDate: addDays(today, DAYS_BG_PENDING),
          notes: `background check pending (~${DAYS_BG_PENDING}d)`,
        };
      }
      if (status === "none") {
        return {
          readyDate: addDays(today, DAYS_BG_NEW),
          notes: `new background check (~${DAYS_BG_NEW}d)`,
        };
      }
      // status === "flagged"
      return {
        readyDate: addDays(today, DAYS_FAR_FUTURE),
        notes: "background check FLAGGED — manual review required",
      };
    }

    case "drug_screen": {
      if (provider.drugScreen.status === "clear") {
        return { readyDate: addDays(today, 0), notes: "drug screen clear" };
      }
      if (provider.drugScreen.status === "flagged") {
        return {
          readyDate: addDays(today, DAYS_FAR_FUTURE),
          notes: "drug screen FLAGGED — manual review required",
        };
      }
      return {
        readyDate: addDays(today, DAYS_DRUG_SCREEN),
        notes: `drug screen ${provider.drugScreen.status} (~${DAYS_DRUG_SCREEN}d)`,
      };
    }

    case "facility_privileges": {
      const canUseTemp =
        facility.supportsTemporaryPrivileges && provider.backgroundCheck.status === "clear";
      if (canUseTemp) {
        const tempDays = facility.tempPrivilegingDays ?? DAYS_DEFAULT_TEMP_PRIVILEGES;
        return {
          readyDate: addDays(today, tempDays),
          notes: `temporary privileges (~${tempDays}d, requires clear background)`,
        };
      }
      return {
        readyDate: addDays(today, facility.privilegingCycleDays),
        notes: `full privileging cycle (~${facility.privilegingCycleDays}d)`,
      };
    }
  }
}

/**
 * Sub-specialty mismatch handling.
 *
 * DECISION: We DO NOT fail the projection when the provider's sub-specialties
 * don't include the facility's required sub-specialty. Instead we still
 * project the credential timeline and flag `confidence = "low"` with a note.
 *
 * Rationale: the credential bridge is one half of ranking ("earliest realistic
 * start"); fit is the other half. The ranker is the right place to drop a
 * sub-specialty-mismatched candidate — the bridge's job is to return a
 * timeline + a clear signal (low confidence + note) so the ranker can decide.
 */
function hasSubSpecialtyMatch(
  provider: ProviderCredentialState,
  facility: FacilityRequirements,
): boolean {
  return provider.specialties.includes(facility.requiredSubSpecialty);
}

/**
 * Detect inputs that should force `confidence = "low"`:
 *   - any `flagged` background check or drug screen (even if not required —
 *     these are contradictory signals against readiness),
 *   - sub-specialty mismatch.
 *
 * NOTE: only credentials in `requiredCredentials` are evaluated for the
 * flagged check; a flag on an unused screen is ignored.
 */
function hasLowConfidenceSignal(input: ProjectionInput): boolean {
  const { provider, facility } = input;
  const req = new Set(facility.requiredCredentials);

  if (!hasSubSpecialtyMatch(provider, facility)) return true;
  if (req.has("background_check") && provider.backgroundCheck.status === "flagged") return true;
  if (req.has("drug_screen") && provider.drugScreen.status === "flagged") return true;
  return false;
}

/**
 * Project the earliest realistic start date for this provider at this
 * facility. Pure function — same inputs always produce the same output.
 */
export function projectEarliestStart(input: ProjectionInput): ProjectionResult {
  const { facility } = input;

  // Preserve the declaration order of requiredCredentials (callers may feed us
  // facility data in whatever order), but tiebreak by CREDENTIAL_ORDER so the
  // result is deterministic regardless of the caller's ordering.
  const required = [...facility.requiredCredentials];

  const breakdown: CredentialReadiness[] = required.map((credential) => {
    const { readyDate, notes } = readyDateFor(credential, input);
    const entry: CredentialReadiness = { credential, readyDate, isBinding: false };
    if (notes !== undefined) entry.notes = notes;
    return entry;
  });

  if (breakdown.length === 0) {
    // Degenerate case: no required credentials at all. Ready today, low
    // confidence because the input is clearly incomplete.
    return {
      earliestStartDate: new Date(input.today.getTime()),
      confidence: "low",
      bindingCredential: "none",
      breakdown: [
        {
          credential: "none",
          readyDate: new Date(input.today.getTime()),
          isBinding: true,
          notes: "no required credentials declared",
        },
      ],
    };
  }

  // MAX across readyDates — the start can't happen before the last credential lands.
  let maxMs = Number.NEGATIVE_INFINITY;
  for (const b of breakdown) {
    if (b.readyDate.getTime() > maxMs) maxMs = b.readyDate.getTime();
  }
  const earliestStartDate = new Date(maxMs);

  // Binding credential: among those tied at maxMs, pick the earliest one in
  // CREDENTIAL_ORDER. If the caller somehow supplied an unknown credential, it
  // gets a very low rank (Infinity) so a known one always wins ties.
  const rankOf = (c: string): number => {
    const idx = CREDENTIAL_ORDER.indexOf(c as RequiredCredential);
    return idx === -1 ? Number.POSITIVE_INFINITY : idx;
  };
  let bindingIdx = -1;
  for (let i = 0; i < breakdown.length; i++) {
    const b = breakdown[i];
    if (!b) continue;
    if (b.readyDate.getTime() !== maxMs) continue;
    if (bindingIdx === -1) {
      bindingIdx = i;
      continue;
    }
    const current = breakdown[bindingIdx];
    if (current && rankOf(b.credential) < rankOf(current.credential)) {
      bindingIdx = i;
    }
  }
  const binding = bindingIdx >= 0 ? breakdown[bindingIdx] : undefined;
  if (binding) binding.isBinding = true;

  // Confidence scoring.
  //  - low   : contradictory / flagged / sub-specialty mismatch
  //  - medium: the binding credential's readyDate is a day-offset estimate
  //            (i.e., not available today)
  //  - high  : every required credential was already satisfied today
  let confidence: Confidence;
  if (hasLowConfidenceSignal(input)) {
    confidence = "low";
    if (!hasSubSpecialtyMatch(input.provider, facility) && binding) {
      const prev = binding.notes;
      binding.notes = prev
        ? `${prev}; sub-specialty mismatch: required ${facility.requiredSubSpecialty}`
        : `sub-specialty mismatch: required ${facility.requiredSubSpecialty}`;
    }
  } else if (binding && binding.readyDate.getTime() > input.today.getTime()) {
    confidence = "medium";
  } else {
    confidence = "high";
  }

  return {
    earliestStartDate,
    confidence,
    bindingCredential: binding?.credential ?? "unknown",
    breakdown,
  };
}

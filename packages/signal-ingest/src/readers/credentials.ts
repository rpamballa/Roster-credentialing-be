/**
 * `roster-internal` · credentials reader
 * --------------------------------------
 *
 * For each provider granted to the seed workspace, emit one credential
 * record per observable fact we have about them:
 *
 *   - Each state in `providers.states_licensed` becomes a
 *     `type="state_license"` credential, status "active" (presence in
 *     the field is our only signal — the credentialing workflow owns
 *     the real lifecycle).
 *
 *   - Each row in `verifications` becomes a credential of type
 *     `verification.type`, pass-through state + status + verified_at.
 *
 *   - Each provider gets ONE synthetic `type="earliest_start"` row
 *     whose `earliest_start_projection` jsonb is produced by
 *     `projectEarliestStart` from `@cred/signal-cred-bridge`. This is
 *     the ranker's input signal (see signal_rankings.entries[].reasons).
 *     The projection is computed against a DEFAULT facility profile —
 *     TX / general / standard credentials — because the ranker needs a
 *     per-provider baseline; the real per-job projection is computed at
 *     ranking time.
 *
 * Fields we don't have on `providers` (DEA, state CSR, board cert
 * details, ACLS, immunizations, background check, drug screen) are
 * emitted as absent credential state: the projection will flag them
 * as missing, and `enumerateCredentialGaps` lists them for operators.
 */

import { db } from "@cred/db";
import {
  providerWorkspaceGrants,
  providers as providersTable,
  verifications,
} from "@cred/db/schema";
import {
  type FacilityRequirements,
  type ProjectionResult,
  type ProviderCredentialState,
  type SubSpecialty,
  projectEarliestStart,
} from "@cred/signal-cred-bridge";
import { and, eq } from "drizzle-orm";
import type { CredentialRecord, ReaderContext } from "../adapters/types.js";
import { ROSTER_INTERNAL_SYSTEM } from "./providers.js";

/**
 * Baseline facility used for the per-provider projection. The real
 * projection runs per-job at rank time; this one is a general
 * reasonableness signal — "how close is this provider to being
 * able to work anywhere?". Anesthesia pilot → anesthesia defaults.
 */
const BASELINE_FACILITY: FacilityRequirements = {
  state: "TX",
  requiredSubSpecialty: "general",
  requiredCredentials: [
    "state_license",
    "dea",
    "state_csr",
    "board_cert",
    "acls",
    "immunizations",
    "background_check",
    "drug_screen",
    "facility_privileges",
  ],
  privilegingCycleDays: 90,
  supportsTemporaryPrivileges: false,
  isImlcCompactState: false,
};

const KNOWN_SUBSPECIALTIES: ReadonlySet<SubSpecialty> = new Set<SubSpecialty>([
  "cardiac",
  "ob",
  "pediatric",
  "pain",
  "general",
]);

export async function readCredentials(ctx: ReaderContext): Promise<CredentialRecord[]> {
  const provRows = await db()
    .select({
      id: providersTable.id,
      firstName: providersTable.firstName,
      lastName: providersTable.lastName,
      npi: providersTable.npi,
      email: providersTable.email,
      phone: providersTable.phone,
      specialties: providersTable.specialties,
      statesLicensed: providersTable.statesLicensed,
    })
    .from(providersTable)
    .innerJoin(
      providerWorkspaceGrants,
      and(
        eq(providerWorkspaceGrants.providerId, providersTable.id),
        eq(providerWorkspaceGrants.workspaceId, ctx.workspaceId),
      ),
    );

  // One round-trip to collect all verification rows for this
  // workspace, then group by provider_id in memory. For the seed
  // agency (hundreds of providers at most) this is cheap and avoids
  // N+1 per-provider queries.
  const verRows = await db()
    .select({
      providerId: verifications.providerId,
      type: verifications.type,
      state: verifications.state,
      licenseNumber: verifications.licenseNumber,
      status: verifications.status,
      verifiedAt: verifications.verifiedAt,
    })
    .from(verifications)
    .where(eq(verifications.workspaceId, ctx.workspaceId));

  const verByProvider = new Map<string, typeof verRows>();
  for (const v of verRows) {
    const list = verByProvider.get(v.providerId) ?? [];
    list.push(v);
    verByProvider.set(v.providerId, list);
  }

  const out: CredentialRecord[] = [];
  for (const p of provRows) {
    const identity = buildIdentity(p);

    // 1) state_license rows derived from providers.states_licensed.
    const licensedStates = p.statesLicensed ?? [];
    for (const state of licensedStates) {
      out.push({
        providerIdentity: identity,
        type: "state_license",
        state,
        status: "active",
        source: {
          externalSystem: ROSTER_INTERNAL_SYSTEM,
          externalId: `providers:${p.id}:license:${state}`,
        },
      });
    }

    // 2) Verifications pass through, one credential per row.
    const vers = verByProvider.get(p.id) ?? [];
    for (const v of vers) {
      out.push({
        providerIdentity: identity,
        type: v.type,
        state: v.state ?? null,
        status: v.status,
        source: {
          externalSystem: ROSTER_INTERNAL_SYSTEM,
          externalId: `verifications:${p.id}:${v.type}:${v.state ?? "-"}:${v.licenseNumber ?? "-"}`,
        },
      });
    }

    // 3) Synthetic earliest_start projection.
    const state = buildProviderCredentialState(p, vers);
    const projection = projectEarliestStart({
      today: new Date(),
      provider: state,
      facility: BASELINE_FACILITY,
    });
    out.push({
      providerIdentity: identity,
      type: "earliest_start",
      state: null,
      status: projection.confidence,
      earliestStartProjection: toJson(projection),
      source: {
        externalSystem: ROSTER_INTERNAL_SYSTEM,
        externalId: `providers:${p.id}:earliest_start_baseline`,
      },
    });
  }

  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function buildIdentity(row: {
  firstName: string;
  lastName: string;
  npi: string | null;
  email: string | null;
  phone: string | null;
}): CredentialRecord["providerIdentity"] {
  const identity: CredentialRecord["providerIdentity"] = {
    name: `${row.firstName} ${row.lastName}`.trim(),
  };
  if (row.npi) identity.npi = row.npi;
  if (row.email) identity.email = row.email;
  if (row.phone) identity.phone = row.phone;
  return identity;
}

/**
 * Pack what we can observe from Roster's own tables into the
 * `ProviderCredentialState` shape `projectEarliestStart` expects.
 * Missing fields collapse to the "none/absent" case — the projection
 * then flags them as the binding credential, which is EXACTLY the
 * signal we want to surface in gaps.
 */
function buildProviderCredentialState(
  provider: {
    specialties: string[] | null;
    statesLicensed: string[] | null;
  },
  vers: Array<{
    type: string;
    state: string | null;
    status: string;
    verifiedAt: Date | null;
  }>,
): ProviderCredentialState {
  const specialties = (provider.specialties ?? [])
    .map((s): SubSpecialty | undefined =>
      KNOWN_SUBSPECIALTIES.has(s as SubSpecialty) ? (s as SubSpecialty) : undefined,
    )
    .filter((s): s is SubSpecialty => s !== undefined);

  const licenses = (provider.statesLicensed ?? []).map((state) => ({
    state,
    status: "active" as const,
  }));

  // We treat any verification whose status starts with "pass"/"active"/
  // "clear" as positive signal; anything else as pending.
  function verStatusFor(type: string): "active" | "pending" | "expired" | "none" {
    const match = vers.find((v) => v.type === type);
    if (!match) return "none";
    const s = match.status.toLowerCase();
    if (s.includes("active") || s.includes("clear") || s === "pass") return "active";
    if (s.includes("expired")) return "expired";
    return "pending";
  }

  function screeningStatusFor(type: string): "clear" | "pending" | "flagged" | "none" {
    const match = vers.find((v) => v.type === type);
    if (!match) return "none";
    const s = match.status.toLowerCase();
    if (s.includes("clear") || s === "pass") return "clear";
    if (s.includes("flag") || s.includes("fail")) return "flagged";
    return "pending";
  }

  return {
    specialties,
    licenses,
    // IMLC eligibility isn't tracked on providers; assume false. v1
    // ATS adapters can supply it.
    imlcEligible: false,
    dea: { status: verStatusFor("dea") },
    stateCsr: [], // we don't have CSR state in the schema today
    boardCert: { status: "none", board: null },
    acls: { valid: verStatusFor("acls") === "active" },
    immunizations: { complete: verStatusFor("immunizations") === "active" },
    backgroundCheck: { status: screeningStatusFor("background_check") },
    drugScreen: { status: screeningStatusFor("drug_screen") },
  };
}

function toJson(p: ProjectionResult): Record<string, unknown> {
  return {
    earliestStartDate: p.earliestStartDate.toISOString(),
    confidence: p.confidence,
    bindingCredential: p.bindingCredential,
    breakdown: p.breakdown.map((b) => ({
      credential: b.credential,
      readyDate: b.readyDate.toISOString(),
      isBinding: b.isBinding,
      ...(b.notes !== undefined ? { notes: b.notes } : {}),
    })),
  };
}

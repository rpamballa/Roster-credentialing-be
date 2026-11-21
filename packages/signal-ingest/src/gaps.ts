/**
 * Credential gap enumeration
 * --------------------------
 *
 * Walk every provider in the workspace and report the credential
 * fields the ranker WOULD have liked but doesn't have:
 *
 *   - `state_csr`: license exists for state X but no corresponding
 *     controlled-substance registration is on file
 *   - `sanctions`: no verification row of type `sanctions` / `oig`
 *     has ever been recorded for this provider
 *   - `dea`: no DEA verification on file
 *   - `background_check`: never verified
 *   - `board_cert`: never verified
 *   - `acls`: never verified
 *   - `immunizations`: never verified
 *   - `drug_screen`: never verified
 *
 * This runs over the data Signal already has — it does NOT call any
 * external vendor (that would belong to the primary-source verify
 * workstream).  The output is a plain-data report suitable for
 * sending to an ops dashboard or the eval harness.
 */

import { db } from "@cred/db";
import {
  providerWorkspaceGrants,
  providers as providersTable,
  verifications,
} from "@cred/db/schema";
import { and, eq, inArray } from "drizzle-orm";

export type CredentialGapKind =
  | "state_csr"
  | "sanctions"
  | "dea"
  | "background_check"
  | "board_cert"
  | "acls"
  | "immunizations"
  | "drug_screen";

export interface ProviderCredentialGap {
  providerId: string;
  providerName: string;
  npi: string | null;
  gaps: Array<{
    kind: CredentialGapKind;
    /** For gaps that are state-scoped (state_csr), which state(s) are missing. */
    states?: string[];
    detail: string;
  }>;
}

export interface EnumerateCredentialGapsArgs {
  workspaceId: string;
}

/**
 * Per-provider list of credential gaps. A provider with no gaps is
 * OMITTED from the result (makes the report smaller and the "N
 * providers have gaps" metric trivial to compute).
 */
export async function enumerateCredentialGaps(
  args: EnumerateCredentialGapsArgs,
): Promise<ProviderCredentialGap[]> {
  const { workspaceId } = args;

  const provRows = await db()
    .select({
      id: providersTable.id,
      firstName: providersTable.firstName,
      lastName: providersTable.lastName,
      npi: providersTable.npi,
      statesLicensed: providersTable.statesLicensed,
    })
    .from(providersTable)
    .innerJoin(
      providerWorkspaceGrants,
      and(
        eq(providerWorkspaceGrants.providerId, providersTable.id),
        eq(providerWorkspaceGrants.workspaceId, workspaceId),
      ),
    );

  if (provRows.length === 0) return [];

  const providerIds = provRows.map((p) => p.id);
  const verRows = await db()
    .select({
      providerId: verifications.providerId,
      type: verifications.type,
      state: verifications.state,
    })
    .from(verifications)
    .where(
      and(
        eq(verifications.workspaceId, workspaceId),
        inArray(verifications.providerId, providerIds),
      ),
    );

  // Group by provider → set of (type, type:state) we've seen.
  interface VerifIndex {
    types: Set<string>;
    byTypeAndState: Set<string>;
  }
  const vIdx = new Map<string, VerifIndex>();
  for (const v of verRows) {
    let idx = vIdx.get(v.providerId);
    if (!idx) {
      idx = { types: new Set(), byTypeAndState: new Set() };
      vIdx.set(v.providerId, idx);
    }
    idx.types.add(v.type.toLowerCase());
    if (v.state) {
      idx.byTypeAndState.add(`${v.type.toLowerCase()}:${v.state.toUpperCase()}`);
    }
  }

  const out: ProviderCredentialGap[] = [];
  for (const p of provRows) {
    const idx = vIdx.get(p.id) ?? { types: new Set<string>(), byTypeAndState: new Set<string>() };
    const gaps: ProviderCredentialGap["gaps"] = [];

    // 1) state_csr — any state in states_licensed without a matching
    //    `state_csr` verification row.
    const statesLicensed = p.statesLicensed ?? [];
    const missingCsrStates: string[] = [];
    for (const state of statesLicensed) {
      if (!idx.byTypeAndState.has(`state_csr:${state.toUpperCase()}`)) {
        missingCsrStates.push(state);
      }
    }
    if (missingCsrStates.length > 0) {
      gaps.push({
        kind: "state_csr",
        states: missingCsrStates,
        detail: `no state_csr verification for ${missingCsrStates.join(", ")}`,
      });
    }

    // 2) scalar gaps — these have exactly one logical slot per provider.
    const scalarGapRules: Array<{
      kind: CredentialGapKind;
      verificationTypes: string[];
      detail: string;
    }> = [
      {
        kind: "sanctions",
        verificationTypes: ["sanctions", "oig", "sam", "exclusion"],
        detail: "no sanction / OIG / SAM exclusion lookup on file",
      },
      {
        kind: "dea",
        verificationTypes: ["dea"],
        detail: "no DEA verification on file",
      },
      {
        kind: "background_check",
        verificationTypes: ["background_check", "background", "bg"],
        detail: "no background check on file",
      },
      {
        kind: "board_cert",
        verificationTypes: ["board_cert", "board_certification", "aba", "aoba"],
        detail: "no board certification verification on file",
      },
      {
        kind: "acls",
        verificationTypes: ["acls"],
        detail: "no ACLS verification on file",
      },
      {
        kind: "immunizations",
        verificationTypes: ["immunizations", "immunization"],
        detail: "no immunization verification on file",
      },
      {
        kind: "drug_screen",
        verificationTypes: ["drug_screen", "drug", "drug_test"],
        detail: "no drug screen on file",
      },
    ];
    for (const rule of scalarGapRules) {
      const present = rule.verificationTypes.some((t) => idx.types.has(t));
      if (!present) gaps.push({ kind: rule.kind, detail: rule.detail });
    }

    if (gaps.length > 0) {
      out.push({
        providerId: p.id,
        providerName: `${p.firstName} ${p.lastName}`.trim(),
        npi: p.npi,
        gaps,
      });
    }
  }

  return out;
}

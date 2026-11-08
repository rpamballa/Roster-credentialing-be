/**
 * Seed a Signal workspace from a fixture.
 *
 * The seeder is idempotent-ish: it adds the providers / jobs / creds
 * declared by the fixture into the workspace the caller hands it.
 * Tests TRUNCATE the signal_* tables between runs, so "idempotent"
 * here really means "safe to call once per freshly-truncated DB" —
 * we do not UPSERT.
 *
 * What we insert, per fixture req:
 *
 *   - One `signal_jobs` row with (workspaceId, specialty, needDate,
 *     state, region, pay).
 *   - One `signal_providers` row PER unique pick in the fixture,
 *     identified by `npi = <picks entry>`. The ranker scores by
 *     sub-specialty + region, so each seeded provider carries the
 *     req's sub-specialty + a region_pref that includes the req's
 *     US region. A fixture pick that appears in multiple reqs
 *     picks up the union of sub-specialties/regions, so a provider
 *     named as the cardiac pick in TX AND the cardiac pick in MA
 *     gets both sub-specialties and both regions.
 *   - One `signal_credentials` row per required credential, with
 *     status "active". This is engineering shorthand: the fixture
 *     is testing the ranker's ORDERING, not the credentialing
 *     bridge's edge cases (those are covered in @cred/signal-cred-
 *     bridge's own tests).
 *
 * The seeder returns a mapping from fixture reqId → signalJobs.id and
 * from fixture-provider-identifier → signalProviders.id so the caller
 * (the harness) can translate ranker output back to fixture ids.
 */

import { db } from "@cred/db";
import type { signalJobs, signalProviders } from "@cred/db/schema";
import { type SignalExecutor, withWorkspace } from "@cred/db/signal";
import type { EvalFixture, EvalFixtureReq, SubSpecialty } from "./fixture.js";
import { allProviderIdsFromFixture } from "./fixture.js";

type SignalProviderRow = typeof signalProviders.$inferSelect;
type SignalJobRow = typeof signalJobs.$inferSelect;

export interface SeedResult {
  /** fixtureReqId → signalJobs.id */
  reqIdToJobId: Record<string, string>;
  /** fixture pick (npi-shaped) → signalProviders.id */
  pickToProviderId: Record<string, string>;
  /** inverse of above, for mapping ranker output back to fixture picks */
  providerIdToPick: Record<string, string>;
}

export interface SeedArgs {
  workspaceId: string;
  fixture: EvalFixture;
  executor?: SignalExecutor;
}

/** Industry-standard locum anesthesia credential set, all active. */
const REQUIRED_CREDENTIAL_TYPES: readonly string[] = [
  "state_license",
  "dea",
  "state_csr",
  "board_cert",
  "acls",
  "immunizations",
  "background_check",
  "drug_screen",
];

const STATE_TO_REGION: Record<string, string> = {
  MA: "NE",
  ME: "NE",
  NH: "NE",
  VT: "NE",
  CT: "NE",
  RI: "NE",
  NY: "MA",
  NJ: "MA",
  PA: "MA",
  MD: "MA",
  DC: "MA",
  DE: "MA",
  FL: "SE",
  GA: "SE",
  NC: "SE",
  SC: "SE",
  TN: "SE",
  VA: "SE",
  AL: "SE",
  MS: "SE",
  OH: "MW",
  MI: "MW",
  IL: "MW",
  IN: "MW",
  WI: "MW",
  MN: "MW",
  IA: "MW",
  MO: "MW",
  KS: "MW",
  NE: "MW",
  ND: "MW",
  SD: "MW",
  KY: "MW",
  TX: "SW",
  OK: "SW",
  AR: "SW",
  LA: "SW",
  NM: "SW",
  AZ: "SW",
  CO: "W",
  UT: "W",
  NV: "W",
  WY: "W",
  MT: "W",
  ID: "W",
  CA: "W",
  OR: "W",
  WA: "W",
  AK: "W",
  HI: "W",
};

function regionForState(state: string): string {
  return STATE_TO_REGION[state.toUpperCase()] ?? "MW";
}

export async function seedFixture(args: SeedArgs): Promise<SeedResult> {
  const { workspaceId, fixture } = args;
  const scoped = withWorkspace(workspaceId, args.executor ?? db());

  // Union of sub-specialties and regions per fixture pick.
  const specialtiesByPick = new Map<string, Set<SubSpecialty>>();
  const regionPrefsByPick = new Map<string, Set<string>>();
  for (const req of fixture.reqs) {
    const region = regionForState(req.facilityState);
    for (const pick of req.placeholderTopPicks) {
      const spec = specialtiesByPick.get(pick) ?? new Set<SubSpecialty>();
      spec.add(req.subSpecialty);
      specialtiesByPick.set(pick, spec);
      const regs = regionPrefsByPick.get(pick) ?? new Set<string>();
      regs.add(region);
      regionPrefsByPick.set(pick, regs);
    }
  }

  // ── providers ─────────────────────────────────────────────────────
  const uniqPicks = allProviderIdsFromFixture(fixture);
  const providerRows: SignalProviderRow[] = [];
  for (const pick of uniqPicks) {
    const [row] = await scoped.providers.insert({
      npi: pick,
      name: `Fixture ${pick}`,
      specialties: Array.from(specialtiesByPick.get(pick) ?? ["general"]),
      regionPrefs: Array.from(regionPrefsByPick.get(pick) ?? []),
      rateBand: "A",
    });
    if (!row) throw new Error(`[signal-eval] seedFixture: no provider row for ${pick}`);
    providerRows.push(row);
  }

  const pickToProviderId: Record<string, string> = {};
  const providerIdToPick: Record<string, string> = {};
  for (const row of providerRows) {
    if (!row.npi) continue;
    pickToProviderId[row.npi] = row.id;
    providerIdToPick[row.id] = row.npi;
  }

  // ── credentials (all active, no binding gap) ──────────────────────
  // All seeded providers hold an active instance of every required
  // credential type across every state any req asks for. This keeps
  // the hard-filter OPEN and lets the fixture test the SOFT-scoring
  // path — which is the behaviour the known-reqs dataset is actually
  // labeling. Edge cases of the bridge live in @cred/signal-cred-
  // bridge's own test suite.
  const allStates = new Set<string>();
  for (const req of fixture.reqs) allStates.add(req.facilityState.toUpperCase());
  for (const row of providerRows) {
    for (const credType of REQUIRED_CREDENTIAL_TYPES) {
      // state_license / state_csr are per-state; others are national.
      if (credType === "state_license" || credType === "state_csr") {
        for (const st of allStates) {
          await scoped.credentials.insert({
            providerId: row.id,
            type: credType,
            state: st,
            status: "active",
          });
        }
      } else {
        await scoped.credentials.insert({
          providerId: row.id,
          type: credType,
          status: credType === "board_cert" ? "certified" : "active",
        });
      }
    }
  }

  // ── jobs ──────────────────────────────────────────────────────────
  const reqIdToJobId: Record<string, string> = {};
  for (const req of fixture.reqs) {
    const jobRow = await insertJob(scoped, req);
    reqIdToJobId[req.reqId] = jobRow.id;
  }

  return { reqIdToJobId, pickToProviderId, providerIdToPick };
}

async function insertJob(
  scoped: ReturnType<typeof withWorkspace>,
  req: EvalFixtureReq,
): Promise<SignalJobRow> {
  const [lo] = req.payRange;
  const [row] = await scoped.jobs.insert({
    specialty: req.subSpecialty,
    state: req.facilityState.toUpperCase(),
    region: regionForState(req.facilityState),
    needDate: req.needDate,
    pay: lo.toFixed(2),
  });
  if (!row) throw new Error(`[signal-eval] seedFixture: no job row for ${req.reqId}`);
  return row;
}

/**
 * Seed a SECOND tenant with the same fixture but different NPIs.
 * Used by the cross-tenant leak probe — the provider identifiers
 * must NOT collide with tenant A's, otherwise a legitimate NPI
 * dedup would look like a leak.
 */
export async function seedFixtureForTenantB(args: SeedArgs): Promise<SeedResult> {
  const { fixture } = args;
  // Clone the fixture with tenant-B-prefixed picks so NPIs don't
  // collide with tenant A's row set. Everything else is a mirror.
  const cloned: EvalFixture = {
    ...fixture,
    reqs: fixture.reqs.map((r) => ({
      ...r,
      placeholderTopPicks: r.placeholderTopPicks.map((p) => `tenantB-${p}`),
    })),
  };
  return seedFixture({ ...args, fixture: cloned });
}

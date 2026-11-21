/**
 * `@cred/signal-eval` · fixture types and loader
 * -----------------------------------------------
 * A fixture is a pinned set of past requisitions with human-judged
 * expected top picks. For v0 those labels are ENGINEERING placeholders
 * (see `label_source: "placeholder-engineering-judgment"`). Before
 * M10 prod promotion they are overwritten with CONSULTANT-grade
 * labels by the domain expert — see README.md.
 *
 * The runner is label-source aware: `--require-consultant-labels`
 * refuses to run against a placeholder fixture, which is how we
 * guarantee the v0 fixture does not sneak into the M10 gate.
 */

import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

export type SubSpecialty = "cardiac" | "ob" | "pediatric" | "pain" | "general";

/** Provenance of the expected labels. Drives the CLI's refusal gate. */
export const PLACEHOLDER_LABEL_SOURCE = "placeholder-engineering-judgment" as const;
export const CONSULTANT_LABEL_SOURCE = "consultant-labels-v1" as const;
export type LabelSource = typeof PLACEHOLDER_LABEL_SOURCE | typeof CONSULTANT_LABEL_SOURCE | string;

export interface EvalFixtureReq {
  reqId: string;
  facilityState: string;
  subSpecialty: SubSpecialty;
  needDate: string; // ISO yyyy-mm-dd
  payRange: [number, number];
  /**
   * Expected top picks. Each entry is either:
   *   - a real NPI from Roster's workspace, OR
   *   - a synthetic id of the form `synthetic-anesthesia-XXX`.
   * The harness seeds `signal_providers` keyed by this value in the
   * eval workspace before ranking; the ranker's returned providerIds
   * are mapped back to NPIs via the seeded providers table.
   */
  placeholderTopPicks: string[];
  /** Short free-text rationale — consultant overwrites this during M10 labeling. */
  rationale: string;
}

export interface EvalFixture {
  fixture_version: string;
  pilot_specialty: string;
  label_source: LabelSource;
  label_source_note: string;
  provider_identifier_convention?: string;
  sub_specialty_distribution?: Partial<Record<SubSpecialty, number>>;
  reqs: EvalFixtureReq[];
}

export function loadFixture(fixturePath: string): EvalFixture {
  const absPath = pathResolve(fixturePath);
  const raw = readFileSync(absPath, "utf8");
  const parsed = JSON.parse(raw) as EvalFixture;
  validateFixture(parsed, absPath);
  return parsed;
}

export function validateFixture(fx: EvalFixture, pathForError: string): void {
  if (!fx || typeof fx !== "object") {
    throw new Error(`[signal-eval] fixture ${pathForError} is not a JSON object`);
  }
  if (!Array.isArray(fx.reqs) || fx.reqs.length === 0) {
    throw new Error(`[signal-eval] fixture ${pathForError} has no reqs array`);
  }
  if (typeof fx.label_source !== "string" || fx.label_source.length === 0) {
    throw new Error(`[signal-eval] fixture ${pathForError} is missing label_source`);
  }
  for (const r of fx.reqs) {
    if (!r.reqId || !r.facilityState || !r.subSpecialty || !r.needDate) {
      throw new Error(
        `[signal-eval] fixture ${pathForError} req ${r.reqId ?? "(no id)"} is missing required fields`,
      );
    }
    if (!Array.isArray(r.placeholderTopPicks) || r.placeholderTopPicks.length === 0) {
      throw new Error(
        `[signal-eval] fixture ${pathForError} req ${r.reqId} has empty placeholderTopPicks`,
      );
    }
    if (!Array.isArray(r.payRange) || r.payRange.length !== 2) {
      throw new Error(`[signal-eval] fixture ${pathForError} req ${r.reqId} has bad payRange`);
    }
  }
}

/** Unique provider identifiers across every req. Used by the seeder. */
export function allProviderIdsFromFixture(fx: EvalFixture): string[] {
  const seen = new Set<string>();
  for (const r of fx.reqs) {
    for (const p of r.placeholderTopPicks) seen.add(p);
  }
  return Array.from(seen).sort();
}

/** True if this fixture uses placeholder (engineering-judgment) labels. */
export function isPlaceholderFixture(fx: EvalFixture): boolean {
  return fx.label_source === PLACEHOLDER_LABEL_SOURCE;
}

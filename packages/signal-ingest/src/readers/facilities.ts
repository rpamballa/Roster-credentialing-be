/**
 * `roster-internal` · facilities reader
 * -------------------------------------
 *
 * There is NO `signal_facilities` table in v0 — `signal_jobs.facility_id`
 * references the existing global `facilities.id` directly (see
 * packages/db/src/schema/signal/jobs.ts). So this reader does NOT
 * produce new rows; it is a no-op stub that documents the decision
 * and ships a VALIDATOR the runner uses to catch broken references.
 *
 * Why this is a reader anyway: the adapter interface declares
 * `readFacilities`. We keep the slot filled with a no-op so a v1
 * external adapter whose FACILITY SET differs from Roster's (a new
 * agency with their own hospital catalog) has an obvious place to
 * plug in — it will populate the facilities table + emit the facility
 * ids it observed for the runner to log.
 */

import { db } from "@cred/db";
import { facilities, signalJobs } from "@cred/db/schema";
import { inArray } from "drizzle-orm";
import type { FacilityRecord, ReaderContext } from "../adapters/types.js";

export async function readFacilities(_ctx: ReaderContext): Promise<FacilityRecord[]> {
  // Intentional no-op for v0. See file header.
  return [];
}

export interface FacilityValidationResult {
  /** Number of `signal_jobs` rows that have a non-null facility_id. */
  checked: number;
  /** Facility ids referenced by `signal_jobs` that have no matching `facilities` row. */
  danglingFacilityIds: string[];
}

/**
 * Validator the runner calls AFTER the jobs reader has run. Every
 * `signal_jobs.facility_id` must resolve to a `facilities` row — a
 * dangling pointer is a correctness bug because the ranker will join
 * through it.
 */
export async function validateFacilityReferences(
  workspaceId: string,
): Promise<FacilityValidationResult> {
  // Collect distinct facility ids referenced by signal_jobs for this
  // workspace. We do this in JS rather than a SQL left-anti-join
  // because the dataset is tiny (seed agency) and the list of
  // dangling ids is the useful payload for the gap report.
  const jobRows = await db()
    .select({ facilityId: signalJobs.facilityId })
    .from(signalJobs)
    .where(inArray(signalJobs.workspaceId, [workspaceId]));

  const referenced = new Set<string>();
  for (const row of jobRows) {
    if (row.facilityId != null) referenced.add(row.facilityId);
  }

  if (referenced.size === 0) {
    return { checked: 0, danglingFacilityIds: [] };
  }

  const existing = await db()
    .select({ id: facilities.id })
    .from(facilities)
    .where(inArray(facilities.id, [...referenced]));
  const existingSet = new Set(existing.map((r) => r.id));

  const dangling: string[] = [];
  for (const id of referenced) {
    if (!existingSet.has(id)) dangling.push(id);
  }

  return { checked: referenced.size, danglingFacilityIds: dangling };
}

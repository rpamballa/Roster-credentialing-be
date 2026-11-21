/**
 * `roster-internal` · jobs reader
 * -------------------------------
 *
 * Reads Roster's own `cases` table and yields one `JobRecord` per
 * open requisition.
 *
 * DECISIONS (all documented in the PR description):
 *
 *   - `need_date` ← `cases.target_submission_date`. The credentialing
 *     cases table doesn't carry a "req needs provider on site" date;
 *     the closest proxy is `target_submission_date` (when the packet
 *     must be submitted). This under-estimates — the facility is
 *     ready some days after submission — but it's the right field for
 *     RANKING urgency.
 *
 *   - `facility_id` is derived by joining `cases.facility_profile_id`
 *     through `facility_profiles` to the global `facilities` row.
 *     (`cases` does NOT carry `facility_id` directly in the current
 *     schema; `signal_jobs.facility_id` references `facilities.id`.)
 *
 *   - `region` / `pay` / `state` are left null for v0 — the
 *     `cases` table doesn't carry them. v1 external ATS readers
 *     (Bullhorn, Sense, Crelate) fill them in.
 *
 *   - Filter: we DO include completed / submitted cases, because the
 *     ranker's historical fit features will want them. Downstream can
 *     filter by `req_opened_at` / status if needed.
 */

import { db } from "@cred/db";
import { cases, facilityProfiles } from "@cred/db/schema";
import { eq, sql } from "drizzle-orm";
import type { JobRecord, ReaderContext } from "../adapters/types.js";
import { ROSTER_INTERNAL_SYSTEM } from "./providers.js";

export async function readJobs(ctx: ReaderContext): Promise<JobRecord[]> {
  const rows = await db()
    .select({
      id: cases.id,
      specialty: cases.specialty,
      targetSubmissionDate: cases.targetSubmissionDate,
      openedAt: cases.openedAt,
      facilityId: facilityProfiles.facilityId,
    })
    .from(cases)
    .leftJoin(facilityProfiles, eq(facilityProfiles.id, cases.facilityProfileId))
    .where(eq(cases.workspaceId, ctx.workspaceId));

  return rows.map((r): JobRecord => {
    const record: JobRecord = {
      facilityId: r.facilityId ?? null,
      specialty: r.specialty,
      needDate: r.targetSubmissionDate ?? null,
      reqOpenedAt: r.openedAt,
      source: { externalSystem: ROSTER_INTERNAL_SYSTEM, externalId: r.id },
    };
    return record;
  });
}

/**
 * Convenience: raw count of case rows for the workspace. Used by the
 * runner's gap-detection path when it wants to know "we have N cases
 * but 0 facility-profile joins succeeded".
 */
export async function countCases(workspaceId: string): Promise<number> {
  const rows = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(cases)
    .where(eq(cases.workspaceId, workspaceId));
  return rows[0]?.n ?? 0;
}

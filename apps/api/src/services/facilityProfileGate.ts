import { type Tx, db, schema } from "@cred/db";
import { eq } from "drizzle-orm";

export class FacilityProfileNotApprovedError extends Error {
  constructor(public readonly facilityProfileId: string) {
    super(`facility profile ${facilityProfileId} is not approved`);
    this.name = "FacilityProfileNotApprovedError";
  }
}

/**
 * Enforce PROMPT M3 §5: a case cannot reference a facility profile in
 * `draft` status. Call this in any code path that creates or updates a
 * case's facility_profile_id.
 */
export async function assertApproved(facilityProfileId: string, tx?: Tx): Promise<void> {
  const runner = tx ?? db();
  // rls: bypass — gate predicate runs inside the workspace tenancy already.
  const [row] = await runner
    .select({ status: schema.facilityProfiles.status })
    .from(schema.facilityProfiles)
    .where(eq(schema.facilityProfiles.id, facilityProfileId))
    .limit(1);
  if (!row || row.status !== "approved") {
    throw new FacilityProfileNotApprovedError(facilityProfileId);
  }
}

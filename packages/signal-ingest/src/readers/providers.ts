/**
 * `roster-internal` · providers reader
 * ------------------------------------
 *
 * Reads Roster's own `providers` table and yields `ProviderRecord`s
 * for the runner to upsert into `signal_providers`.
 *
 * The internal `providers` table is NOT workspace-scoped (see
 * packages/db/src/schema/providers.ts) — a single provider row may be
 * granted to many workspaces via `provider_workspace_grants`. For
 * v0 the seed agency reads EVERY provider granted to its workspace;
 * we restrict the query with an inner join on `provider_workspace_grants`.
 *
 * Provider identity is forwarded to the runner; the runner calls
 * `resolveProvider` so repeated reads against the same NPI never
 * create duplicate `signal_providers` rows.
 */

import { db } from "@cred/db";
import { providerWorkspaceGrants, providers } from "@cred/db/schema";
import { and, eq } from "drizzle-orm";
import type { ProviderRecord, ReaderContext } from "../adapters/types.js";

export const ROSTER_INTERNAL_SYSTEM = "roster-internal";

export async function readProviders(ctx: ReaderContext): Promise<ProviderRecord[]> {
  const rows = await db()
    .select({
      id: providers.id,
      npi: providers.npi,
      firstName: providers.firstName,
      lastName: providers.lastName,
      email: providers.email,
      phone: providers.phone,
      specialties: providers.specialties,
      statesLicensed: providers.statesLicensed,
    })
    .from(providers)
    .innerJoin(
      providerWorkspaceGrants,
      and(
        eq(providerWorkspaceGrants.providerId, providers.id),
        eq(providerWorkspaceGrants.workspaceId, ctx.workspaceId),
      ),
    );

  return rows.map((r) => {
    const record: ProviderRecord = {
      name: `${r.firstName} ${r.lastName}`.trim(),
      specialties: r.specialties ?? [],
      regionPrefs: r.statesLicensed ?? [],
      source: { externalSystem: ROSTER_INTERNAL_SYSTEM, externalId: r.id },
    };
    // Spreads are gated so `exactOptionalPropertyTypes` is happy —
    // {npi: undefined} is NOT the same as omitting the key under
    // that flag, and `ProviderIdentity` on the resolver side cares.
    if (r.npi) record.npi = r.npi;
    if (r.email) record.email = r.email;
    if (r.phone) record.phone = r.phone;
    return record;
  });
}

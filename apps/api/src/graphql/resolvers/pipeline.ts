import { schema, withTenancy } from "@cred/db";
import type { Blocker as DomainBlocker } from "@cred/types/domain";
import { and, eq } from "drizzle-orm";
import type { GqlContext } from "../context.js";
import { computeSlaRisk, daysToTarget, stageFor, toFeCaseStatus } from "../mappings.js";
import type { CaseSummaryGql } from "./types.js";

interface PipelineArgs {
  q?: string | null;
  slaRisk?: string | null;
  stage?: string | null;
  needsReviewOnly?: boolean | null;
}

function blockerCount(blockers: DomainBlocker[] | null | undefined): number {
  if (!blockers) return 0;
  return blockers.filter((b) => !b.resolvedAt).length;
}

function hasReview(blockers: DomainBlocker[] | null | undefined): boolean {
  if (!blockers) return false;
  return blockers.some(
    (b) => !b.resolvedAt && (b.type === "low_confidence_field" || b.type === "facility_form_mapping_gap"),
  );
}

export async function pipelineCasesResolver(
  _src: unknown,
  args: PipelineArgs,
  ctx: GqlContext,
): Promise<CaseSummaryGql[]> {
  const rows = await withTenancy(ctx.tenancy, async (tx) => {
    return tx
      .select({
        id: schema.cases.id,
        status: schema.cases.status,
        openedAt: schema.cases.openedAt,
        targetSubmissionDate: schema.cases.targetSubmissionDate,
        specialty: schema.cases.specialty,
        blockers: schema.cases.blockers,
        facilityProfileId: schema.cases.facilityProfileId,
        assignedSpecialistId: schema.cases.assignedSpecialistId,
        providerId: schema.providers.id,
        providerFirst: schema.providers.firstName,
        providerLast: schema.providers.lastName,
        providerNpi: schema.providers.npi,
      })
      .from(schema.cases)
      .innerJoin(schema.providers, eq(schema.providers.id, schema.cases.providerId))
      .where(eq(schema.cases.workspaceId, ctx.tenancy.workspaceId));
  });

  // Resolve facility name + specialist name in batch.
  const facilityProfileIds = Array.from(
    new Set(rows.map((r) => r.facilityProfileId).filter((id): id is string => Boolean(id))),
  );
  const specialistIds = Array.from(
    new Set(rows.map((r) => r.assignedSpecialistId).filter((id): id is string => Boolean(id))),
  );

  const [facilityMap, specialistMap] = await withTenancy(ctx.tenancy, async (tx) => {
    const fMap = new Map<string, { facilityId: string; name: string }>();
    if (facilityProfileIds.length > 0) {
      const profileRows = await tx
        .select({
          profileId: schema.facilityProfiles.id,
          facilityId: schema.facilityProfiles.facilityId,
          name: schema.facilities.name,
        })
        .from(schema.facilityProfiles)
        .innerJoin(schema.facilities, eq(schema.facilities.id, schema.facilityProfiles.facilityId));
      for (const p of profileRows) {
        if (facilityProfileIds.includes(p.profileId)) {
          fMap.set(p.profileId, { facilityId: p.facilityId, name: p.name });
        }
      }
    }
    const sMap = new Map<string, { id: string; fullName: string }>();
    if (specialistIds.length > 0) {
      // rls: bypass — users is a global table, no PHI surfaced here.
      const userRows = await tx
        .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users);
      for (const u of userRows) {
        if (specialistIds.includes(u.id)) {
          sMap.set(u.id, { id: u.id, fullName: u.name ?? u.email });
        }
      }
    }
    return [fMap, sMap] as const;
  });

  const now = new Date();
  const all = rows.map((r): CaseSummaryGql => {
    const target = r.targetSubmissionDate ? String(r.targetSubmissionDate) : null;
    const dtt = daysToTarget(target, now);
    const facility = r.facilityProfileId ? facilityMap.get(r.facilityProfileId) : undefined;
    const specialist = r.assignedSpecialistId
      ? specialistMap.get(r.assignedSpecialistId) ?? null
      : null;
    const blockers = r.blockers as DomainBlocker[];
    const stage = stageFor(r.status);
    return {
      id: r.id,
      status: toFeCaseStatus(r.status),
      slaRisk: computeSlaRisk(dtt),
      stage,
      daysToTarget: dtt,
      blockerCount: blockerCount(blockers),
      needsHumanReview: hasReview(blockers),
      openedAt: r.openedAt.toISOString(),
      targetSubmissionDate: target,
      provider: {
        id: r.providerId,
        fullName: `${r.providerFirst} ${r.providerLast}`.trim(),
        npi: r.providerNpi ?? null,
        specialty: r.specialty,
      },
      facility: {
        id: facility?.facilityId ?? "",
        name: facility?.name ?? "",
      },
      assignedSpecialist: specialist,
    };
  });

  const q = args.q?.toLowerCase().trim();
  return all.filter((row) => {
    if (args.needsReviewOnly && !row.needsHumanReview) return false;
    if (args.slaRisk && args.slaRisk !== "all" && row.slaRisk !== args.slaRisk) return false;
    if (args.stage && args.stage !== "all" && row.stage !== args.stage) return false;
    if (q) {
      const hay =
        `${row.provider.fullName} ${row.provider.npi ?? ""} ${row.facility.name} ${row.stage}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// rls-safe wrapper used by the provider resolver to surface this provider's
// case history scoped to the active workspace.
export async function caseSummariesForProvider(
  providerId: string,
  ctx: GqlContext,
): Promise<CaseSummaryGql[]> {
  const rows = await withTenancy(ctx.tenancy, async (tx) => {
    return tx
      .select({
        id: schema.cases.id,
        status: schema.cases.status,
        openedAt: schema.cases.openedAt,
        targetSubmissionDate: schema.cases.targetSubmissionDate,
        specialty: schema.cases.specialty,
        blockers: schema.cases.blockers,
        facilityProfileId: schema.cases.facilityProfileId,
        assignedSpecialistId: schema.cases.assignedSpecialistId,
        providerId: schema.providers.id,
        providerFirst: schema.providers.firstName,
        providerLast: schema.providers.lastName,
        providerNpi: schema.providers.npi,
      })
      .from(schema.cases)
      .innerJoin(schema.providers, eq(schema.providers.id, schema.cases.providerId))
      .where(
        and(
          eq(schema.cases.workspaceId, ctx.tenancy.workspaceId),
          eq(schema.cases.providerId, providerId),
        ),
      );
  });

  const facilityProfileIds = Array.from(
    new Set(rows.map((r) => r.facilityProfileId).filter((id): id is string => Boolean(id))),
  );

  const facilityMap = await withTenancy(ctx.tenancy, async (tx) => {
    const map = new Map<string, { facilityId: string; name: string }>();
    if (facilityProfileIds.length === 0) return map;
    const profileRows = await tx
      .select({
        profileId: schema.facilityProfiles.id,
        facilityId: schema.facilityProfiles.facilityId,
        name: schema.facilities.name,
      })
      .from(schema.facilityProfiles)
      .innerJoin(schema.facilities, eq(schema.facilities.id, schema.facilityProfiles.facilityId));
    for (const p of profileRows) {
      if (facilityProfileIds.includes(p.profileId)) {
        map.set(p.profileId, { facilityId: p.facilityId, name: p.name });
      }
    }
    return map;
  });

  const now = new Date();
  return rows.map((r): CaseSummaryGql => {
    const target = r.targetSubmissionDate ? String(r.targetSubmissionDate) : null;
    const dtt = daysToTarget(target, now);
    const facility = r.facilityProfileId ? facilityMap.get(r.facilityProfileId) : undefined;
    const blockers = r.blockers as DomainBlocker[];
    return {
      id: r.id,
      status: toFeCaseStatus(r.status),
      slaRisk: computeSlaRisk(dtt),
      stage: stageFor(r.status),
      daysToTarget: dtt,
      blockerCount: blockerCount(blockers),
      needsHumanReview: hasReview(blockers),
      openedAt: r.openedAt.toISOString(),
      targetSubmissionDate: target,
      provider: {
        id: r.providerId,
        fullName: `${r.providerFirst} ${r.providerLast}`.trim(),
        npi: r.providerNpi ?? null,
        specialty: r.specialty,
      },
      facility: {
        id: facility?.facilityId ?? "",
        name: facility?.name ?? "",
      },
      assignedSpecialist: null,
    };
  });
}

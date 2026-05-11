import { db, schema, withTenancy } from "@cred/db";
import { audit } from "@cred/observability";
import { and, eq } from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { GqlContext } from "../context.js";

interface FacilityProfileGql {
  id: string;
  facilityId: string;
  facilityName: string;
  version: number;
  status: string;
  approvedAt: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FacilityProfileDetailGql {
  profile: FacilityProfileGql;
  requirements: unknown;
  sourcePacketUri: string | null;
}

function staffUserId(ctx: GqlContext): string {
  const userId = ctx.tenancy.userId;
  if (!userId) {
    throw new GraphQLError("unauthorized", { extensions: { code: "UNAUTHORIZED" } });
  }
  return userId;
}

async function list(
  _src: unknown,
  args: { status?: string | null },
  ctx: GqlContext,
): Promise<FacilityProfileGql[]> {
  return withTenancy(ctx.tenancy, async (tx) => {
    const whereClauses = [eq(schema.facilityProfiles.workspaceId, ctx.tenancy.workspaceId)];
    if (args.status) whereClauses.push(eq(schema.facilityProfiles.status, args.status));

    const rows = await tx
      .select({
        id: schema.facilityProfiles.id,
        facilityId: schema.facilityProfiles.facilityId,
        version: schema.facilityProfiles.version,
        status: schema.facilityProfiles.status,
        approvedAt: schema.facilityProfiles.approvedAt,
        approvedBy: schema.facilityProfiles.approvedBy,
        createdAt: schema.facilityProfiles.createdAt,
        updatedAt: schema.facilityProfiles.updatedAt,
        facilityName: schema.facilities.name,
      })
      .from(schema.facilityProfiles)
      .innerJoin(schema.facilities, eq(schema.facilities.id, schema.facilityProfiles.facilityId))
      .where(and(...whereClauses));

    return rows.map((r) => ({
      ...r,
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  });
}

async function byId(
  _src: unknown,
  args: { id: string },
  ctx: GqlContext,
): Promise<FacilityProfileDetailGql | null> {
  return withTenancy(ctx.tenancy, async (tx) => {
    const [row] = await tx
      .select({
        id: schema.facilityProfiles.id,
        facilityId: schema.facilityProfiles.facilityId,
        version: schema.facilityProfiles.version,
        status: schema.facilityProfiles.status,
        approvedAt: schema.facilityProfiles.approvedAt,
        approvedBy: schema.facilityProfiles.approvedBy,
        createdAt: schema.facilityProfiles.createdAt,
        updatedAt: schema.facilityProfiles.updatedAt,
        requirements: schema.facilityProfiles.requirements,
        sourcePacketUri: schema.facilityProfiles.sourcePacketUri,
        facilityName: schema.facilities.name,
      })
      .from(schema.facilityProfiles)
      .innerJoin(schema.facilities, eq(schema.facilities.id, schema.facilityProfiles.facilityId))
      .where(eq(schema.facilityProfiles.id, args.id))
      .limit(1);
    if (!row) return null;

    return {
      profile: {
        id: row.id,
        facilityId: row.facilityId,
        facilityName: row.facilityName,
        version: row.version,
        status: row.status,
        approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
        approvedBy: row.approvedBy,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
      requirements: row.requirements,
      sourcePacketUri: row.sourcePacketUri,
    };
  });
}

async function correct(
  _src: unknown,
  args: { input: { id: string; fieldPath: string; after: unknown } },
  ctx: GqlContext,
): Promise<FacilityProfileGql> {
  const userId = staffUserId(ctx);
  const { id, fieldPath, after } = args.input;

  const updated = await withTenancy(ctx.tenancy, async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.facilityProfiles)
      .where(eq(schema.facilityProfiles.id, id))
      .limit(1);
    if (!current) return null;
    if (current.status !== "draft") {
      throw new GraphQLError("only draft profiles can be corrected", {
        extensions: { code: "INVALID_STATE" },
      });
    }

    const before = getByPath(current.requirements as unknown as Record<string, unknown>, fieldPath);
    const nextRequirements = setByPath(
      structuredClone(current.requirements as unknown as Record<string, unknown>),
      fieldPath,
      after,
    );

    const [next] = await tx
      .update(schema.facilityProfiles)
      .set({ requirements: nextRequirements as never, updatedAt: new Date() })
      .where(eq(schema.facilityProfiles.id, id))
      .returning();
    if (!next) throw new GraphQLError("update failed");

    await tx.insert(schema.trainingCorrections).values({
      workspaceId: ctx.tenancy.workspaceId,
      facilityProfileId: id,
      fieldPath,
      before: before ?? null,
      after: after as never,
      correctedBy: userId,
      sourceTask: "facility.parse",
    });

    const [facility] = await tx
      .select({ name: schema.facilities.name })
      .from(schema.facilities)
      .where(eq(schema.facilities.id, next.facilityId))
      .limit(1);

    return { row: next, facilityName: facility?.name ?? "" };
  });

  if (!updated)
    throw new GraphQLError("facility profile not found", { extensions: { code: "NOT_FOUND" } });

  await audit({
    workspaceId: ctx.tenancy.workspaceId,
    actorUserId: userId,
    actorType: "user",
    action: "facility_profile.corrected",
    targetEntityType: "facility_profile",
    targetEntityId: updated.row.id,
    after: { fieldPath },
    requestId: ctx.requestId,
  });

  return {
    id: updated.row.id,
    facilityId: updated.row.facilityId,
    facilityName: updated.facilityName,
    version: updated.row.version,
    status: updated.row.status,
    approvedAt: updated.row.approvedAt ? updated.row.approvedAt.toISOString() : null,
    approvedBy: updated.row.approvedBy,
    createdAt: updated.row.createdAt.toISOString(),
    updatedAt: updated.row.updatedAt.toISOString(),
  };
}

async function approve(
  _src: unknown,
  args: { id: string },
  ctx: GqlContext,
): Promise<FacilityProfileGql> {
  const userId = staffUserId(ctx);

  const approved = await withTenancy(ctx.tenancy, async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.facilityProfiles)
      .where(eq(schema.facilityProfiles.id, args.id))
      .limit(1);
    if (!current) return null;
    if (current.status !== "draft") {
      throw new GraphQLError("only draft profiles can be approved", {
        extensions: { code: "INVALID_STATE" },
      });
    }

    const [next] = await tx
      .update(schema.facilityProfiles)
      .set({
        status: "approved",
        approvedAt: new Date(),
        approvedBy: userId,
        updatedAt: new Date(),
      })
      .where(eq(schema.facilityProfiles.id, args.id))
      .returning();
    if (!next) throw new GraphQLError("approve failed");

    await tx.insert(schema.facilityProfileVersions).values({
      facilityProfileId: next.id,
      workspaceId: ctx.tenancy.workspaceId,
      version: next.version,
      requirements: next.requirements,
      approvedAt: next.approvedAt ?? new Date(),
      approvedBy: userId,
    });

    const [facility] = await tx
      .select({ name: schema.facilities.name })
      .from(schema.facilities)
      .where(eq(schema.facilities.id, next.facilityId))
      .limit(1);

    return { row: next, facilityName: facility?.name ?? "" };
  });

  if (!approved)
    throw new GraphQLError("facility profile not found", { extensions: { code: "NOT_FOUND" } });

  await audit({
    workspaceId: ctx.tenancy.workspaceId,
    actorUserId: userId,
    actorType: "user",
    action: "facility_profile.approved",
    targetEntityType: "facility_profile",
    targetEntityId: approved.row.id,
    after: { version: approved.row.version },
    requestId: ctx.requestId,
  });

  return {
    id: approved.row.id,
    facilityId: approved.row.facilityId,
    facilityName: approved.facilityName,
    version: approved.row.version,
    status: approved.row.status,
    approvedAt: approved.row.approvedAt ? approved.row.approvedAt.toISOString() : null,
    approvedBy: approved.row.approvedBy,
    createdAt: approved.row.createdAt.toISOString(),
    updatedAt: approved.row.updatedAt.toISOString(),
  };
}

// Tiny `a.b[0].c` path helpers. Used only against the JSON requirements blob.
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const segs = splitPath(path);
  let cur: unknown = obj;
  for (const seg of segs) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const segs = splitPath(path);
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (seg === undefined) continue;
    const nextSeg = segs[i + 1];
    const nextIsIndex = nextSeg !== undefined && /^\d+$/.test(nextSeg);
    const existing = cur[seg];
    if (existing === undefined || existing === null) {
      cur[seg] = nextIsIndex ? [] : {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  const last = segs[segs.length - 1];
  if (last !== undefined) cur[last] = value;
  return obj;
}

function splitPath(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((s) => s.length > 0);
}

export const facilityResolvers = { list, byId, correct, approve };

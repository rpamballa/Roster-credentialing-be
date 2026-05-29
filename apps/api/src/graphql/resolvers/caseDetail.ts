import { schema, withTenancy } from "@cred/db";
import type {
  Blocker as DomainBlocker,
  ExtractedField as DomainExtractedField,
} from "@cred/types/domain";
import type { FacilityRequirements } from "@cred/types";
import { and, eq } from "drizzle-orm";
import type { GqlContext } from "../context.js";
import {
  computeSlaRisk,
  daysToTarget,
  stageFor,
  toFeCaseStatus,
  toFeDocumentType,
} from "../mappings.js";
import type {
  BlockerGql,
  CaseDetailGql,
  DocumentSummaryGql,
  ExtractedFieldGql,
  ReferenceGql,
  RequirementRowGql,
  TimelineEventGql,
} from "./types.js";

const LOW_CONFIDENCE_THRESHOLD = 0.75;

function mapExtractionStatus(
  status: string,
): "pending" | "processing" | "ready" | "failed" {
  switch (status) {
    case "running":
      return "processing";
    case "succeeded":
      return "ready";
    case "needs_review":
      return "ready";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

function humanizeFieldKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

export function mapExtractedFields(fields: DomainExtractedField[] | null): ExtractedFieldGql[] {
  if (!fields) return [];
  return fields.map((f) => ({
    key: f.name,
    label: humanizeFieldKey(f.name),
    value: f.value === null ? "" : String(f.value),
    confidence: f.confidence,
    bbox:
      f.bbox && typeof f.page === "number"
        ? { page: f.page, bbox: f.bbox }
        : null,
  }));
}

function mapBlockers(blockers: DomainBlocker[] | null | undefined): BlockerGql[] {
  if (!blockers) return [];
  return blockers
    .filter((b) => !b.resolvedAt)
    .map(
      (b, i): BlockerGql => ({
        id: `blocker_${i}_${b.raisedAt}`,
        kind: b.type,
        message: b.message,
        documentId: null,
        requirementKey: null,
        raisedAt: b.raisedAt,
      }),
    );
}

export async function caseDetailResolver(
  _src: unknown,
  args: { id: string },
  ctx: GqlContext,
): Promise<CaseDetailGql | null> {
  const detail = await withTenancy(ctx.tenancy, async (tx) => {
    const [cs] = await tx
      .select()
      .from(schema.cases)
      .where(and(eq(schema.cases.id, args.id), eq(schema.cases.workspaceId, ctx.tenancy.workspaceId)))
      .limit(1);
    if (!cs) return null;

    const [prov] = await tx
      .select()
      .from(schema.providers)
      .where(eq(schema.providers.id, cs.providerId))
      .limit(1);

    let facilityName = "";
    let facilityAddress: string | null = null;
    let facilityId = "";
    let requirements: FacilityRequirements | null = null;
    if (cs.facilityProfileId) {
      const [profile] = await tx
        .select({
          id: schema.facilityProfiles.id,
          facilityId: schema.facilityProfiles.facilityId,
          requirements: schema.facilityProfiles.requirements,
          name: schema.facilities.name,
          address: schema.facilities.address,
        })
        .from(schema.facilityProfiles)
        .innerJoin(schema.facilities, eq(schema.facilities.id, schema.facilityProfiles.facilityId))
        .where(eq(schema.facilityProfiles.id, cs.facilityProfileId))
        .limit(1);
      if (profile) {
        facilityId = profile.facilityId;
        facilityName = profile.name;
        facilityAddress = profile.address;
        requirements = profile.requirements as FacilityRequirements;
      }
    }

    const docs = prov
      ? await tx
          .select()
          .from(schema.documents)
          .where(eq(schema.documents.providerId, prov.id))
      : [];

    const refs = await tx
      .select()
      .from(schema.references)
      .where(eq(schema.references.caseId, cs.id));

    let specialistName: string | null = null;
    if (cs.assignedSpecialistId) {
      const [u] = await tx
        .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, cs.assignedSpecialistId))
        .limit(1);
      if (u) specialistName = u.name ?? u.email;
    }

    return {
      cs,
      prov,
      facilityId,
      facilityName,
      facilityAddress,
      requirements,
      docs,
      refs,
      specialistName,
    };
  });

  if (!detail || !detail.prov) return null;

  const target = detail.cs.targetSubmissionDate
    ? String(detail.cs.targetSubmissionDate)
    : null;
  const dtt = daysToTarget(target);

  const reqs = detail.requirements?.required_documents ?? [];

  // Map requirements to rows by matching against the provider's documents on
  // type. The frontend stable key is `req_<documentType>_<index>`.
  const requirements: RequirementRowGql[] = reqs.map((rd, i): RequirementRowGql => {
    const feType = toFeDocumentType(rd.type);
    const matching = detail.docs.find((d) => d.documentType === rd.type);
    const now = Date.now();

    const lowConfidence =
      matching?.extractedFields?.some((f) => f.confidence < LOW_CONFIDENCE_THRESHOLD) ?? false;
    const expired =
      matching?.expiresAt !== null && matching?.expiresAt !== undefined
        ? matching.expiresAt.getTime() < now
        : false;

    let state: RequirementRowGql["state"] = "missing";
    let needsReview = false;
    if (matching) {
      if (expired) state = "expired";
      else if (lowConfidence) {
        state = "low_confidence";
        needsReview = true;
      } else if (matching.confirmedAt) state = "fulfilled";
      else state = "uploaded";
    }

    const docSummary: DocumentSummaryGql | null = matching
      ? {
          id: matching.id,
          type: feType ?? "medical_license",
          thumbnailUrl: null,
          pageCount: matching.pageCount ?? 1,
          uploadedAt: matching.uploadedAt.toISOString(),
          expiresAt: matching.expiresAt ? matching.expiresAt.toISOString() : null,
          extractionStatus: mapExtractionStatus(matching.extractionStatus),
          reusedFromPriorCase:
            matching.uploadedAt.getTime() < detail.cs.openedAt.getTime(),
          extractedFields: mapExtractedFields(matching.extractedFields),
        }
      : null;

    return {
      key: `req_${rd.type}_${i}`,
      documentType: feType ?? "medical_license",
      label: humanizeFieldKey(rd.type),
      state,
      needsReview,
      document: docSummary,
    };
  });

  const blockers = mapBlockers(detail.cs.blockers);

  // Synthesize a minimal timeline from the available row timestamps. A
  // richer event log is M4+ work but the frontend renders any list of
  // TimelineEvent it receives.
  const timeline: TimelineEventGql[] = [];
  timeline.push({
    id: `tl_open_${detail.cs.id}`,
    kind: "case_opened",
    actor: "specialist",
    actorName: detail.specialistName,
    message: "Case opened",
    timestamp: detail.cs.openedAt.toISOString(),
  });
  for (const d of detail.docs) {
    timeline.push({
      id: `tl_doc_${d.id}_uploaded`,
      kind: "document_uploaded",
      actor: "provider",
      actorName: null,
      message: `${humanizeFieldKey(d.documentType)} uploaded`,
      timestamp: d.uploadedAt.toISOString(),
    });
    if (d.confirmedAt) {
      timeline.push({
        id: `tl_doc_${d.id}_confirmed`,
        kind: "document_confirmed",
        actor: "provider",
        actorName: null,
        message: `${humanizeFieldKey(d.documentType)} confirmed`,
        timestamp: d.confirmedAt.toISOString(),
      });
    }
  }
  if (detail.cs.submittedAt) {
    timeline.push({
      id: `tl_submitted_${detail.cs.id}`,
      kind: "submitted",
      actor: "specialist",
      actorName: detail.specialistName,
      message: "Packet submitted",
      timestamp: detail.cs.submittedAt.toISOString(),
    });
  }

  const references: ReferenceGql[] = detail.refs.map(
    (r): ReferenceGql => ({
      id: r.id,
      fullName: r.name,
      email: r.email ?? "",
      organization: "",
      relationship: r.relationship ?? "peer_physician",
      status: r.status,
      completedAt: r.respondedAt ? r.respondedAt.toISOString() : null,
    }),
  );

  const readyForSubmission =
    requirements.length > 0 &&
    requirements.every((r) => r.state === "fulfilled") &&
    blockers.length === 0;

  return {
    id: detail.cs.id,
    status: toFeCaseStatus(detail.cs.status),
    slaRisk: computeSlaRisk(dtt),
    stage: stageFor(detail.cs.status),
    openedAt: detail.cs.openedAt.toISOString(),
    targetSubmissionDate: target,
    submittedAt: detail.cs.submittedAt ? detail.cs.submittedAt.toISOString() : null,
    provider: {
      id: detail.prov.id,
      fullName: `${detail.prov.firstName} ${detail.prov.lastName}`.trim(),
      npi: detail.prov.npi,
      email: detail.prov.email,
      phone: detail.prov.phone,
      specialty: detail.cs.specialty,
    },
    facility: {
      id: detail.facilityId,
      name: detail.facilityName,
      profileId: detail.cs.facilityProfileId ?? "",
    },
    assignedSpecialist: detail.specialistName
      ? { id: detail.cs.assignedSpecialistId ?? "", fullName: detail.specialistName }
      : null,
    requirements,
    references,
    blockers,
    timeline,
    readyForSubmission,
  };
}


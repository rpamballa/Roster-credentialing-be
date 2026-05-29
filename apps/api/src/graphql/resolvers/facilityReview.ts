import { schema, withTenancy } from "@cred/db";
import { getObjectStorage } from "@cred/storage";
import type { FacilityRequirements } from "@cred/types";
import { eq } from "drizzle-orm";
import type { GqlContext } from "../context.js";
import { slugify, toFeDocumentType, toFeFacilityProfileStatus } from "../mappings.js";
import type {
  FacilityProfileAttestationGql,
  FacilityProfilePrivilegeGroupGql,
  FacilityProfileRequirementDocGql,
  FacilityProfileReviewGql,
  FacilityProfileSubmissionGql,
  FacilityProfileVerificationGql,
} from "./types.js";

// The bbox citation lives at requirements.required_documents[i].bbox_citation,
// not at a top-level review-flag sidecar. Until M5 adds an explicit per-field
// review-flag sidecar, we approximate `needsReview` as "no citation" since
// the parser stamps citations for confidently extracted fields.
function inferNeedsReview(citationPresent: boolean): boolean {
  return !citationPresent;
}

export async function facilityProfileReviewResolver(
  _src: unknown,
  args: { id: string },
  ctx: GqlContext,
): Promise<FacilityProfileReviewGql | null> {
  const row = await withTenancy(ctx.tenancy, async (tx) => {
    const [r] = await tx
      .select({
        id: schema.facilityProfiles.id,
        facilityId: schema.facilityProfiles.facilityId,
        version: schema.facilityProfiles.version,
        status: schema.facilityProfiles.status,
        sourcePacketUri: schema.facilityProfiles.sourcePacketUri,
        requirements: schema.facilityProfiles.requirements,
        name: schema.facilities.name,
        address: schema.facilities.address,
      })
      .from(schema.facilityProfiles)
      .innerJoin(schema.facilities, eq(schema.facilities.id, schema.facilityProfiles.facilityId))
      .where(eq(schema.facilityProfiles.id, args.id))
      .limit(1);
    return r ?? null;
  });
  if (!row) return null;

  const requirements = row.requirements as FacilityRequirements;

  let sourcePacketUrl: string | null = null;
  if (row.sourcePacketUri) {
    const signed = await getObjectStorage().getSignedUrl({
      key: row.sourcePacketUri,
      expiresInSeconds: 30 * 60,
    });
    sourcePacketUrl = signed.url;
  }

  const documents: FacilityProfileRequirementDocGql[] =
    requirements.required_documents.map(
      (rd, i): FacilityProfileRequirementDocGql => {
        const feType = toFeDocumentType(rd.type) ?? "medical_license";
        return {
          key: `doc_${rd.type}_${i}`,
          documentType: feType,
          count: rd.count,
          attestationRequired: rd.attestation_required,
          conditions: rd.conditions ?? [],
          needsReview: inferNeedsReview(Boolean(rd.bbox_citation)),
          bbox: rd.bbox_citation
            ? { page: rd.bbox_citation.page, bbox: rd.bbox_citation.bbox }
            : null,
        };
      },
    );

  const verifications: FacilityProfileVerificationGql[] =
    requirements.required_verifications.map(
      (rv, i): FacilityProfileVerificationGql => ({
        key: `ver_${rv.type}_${i}`,
        type: rv.type,
        sourcePriority: rv.source_priority,
        recencyDays: rv.recency_days,
        needsReview: inferNeedsReview(Boolean(rv.bbox_citation)),
        bbox: rv.bbox_citation
          ? { page: rv.bbox_citation.page, bbox: rv.bbox_citation.bbox }
          : null,
      }),
    );

  const attestations: FacilityProfileAttestationGql[] = requirements.attestations.map(
    (a, i): FacilityProfileAttestationGql => ({
      key: `att_${a.signer_role}_${i}`,
      text: a.text,
      signerRole: a.signer_role,
      format: a.format,
      needsReview: false,
    }),
  );

  const submission: FacilityProfileSubmissionGql = {
    method: requirements.submission.method,
    recipient: requirements.submission.recipient ?? null,
    deadlineDaysBeforeEffective:
      requirements.submission.deadline_days_before_effective ?? null,
    needsReview: !requirements.submission.recipient,
  };

  const privilegeDelineations: FacilityProfilePrivilegeGroupGql[] =
    requirements.privilege_delineations.map(
      (pd): FacilityProfilePrivilegeGroupGql => ({
        specialty: pd.specialty,
        privileges: pd.privileges.map((p) => ({
          key: `priv_${slugify(pd.specialty)}_${slugify(p.name)}`,
          name: p.name,
          requiresVolume: p.requires_volume,
          threshold: p.threshold
            ? { count: p.threshold.count, periodMonths: p.threshold.period_months }
            : null,
          needsReview: false,
          bbox: null,
        })),
      }),
    );

  const reviewQueueCount =
    documents.filter((d) => d.needsReview).length +
    verifications.filter((v) => v.needsReview).length +
    attestations.filter((a) => a.needsReview).length +
    (submission.needsReview ? 1 : 0);

  return {
    id: row.id,
    version: row.version,
    status: toFeFacilityProfileStatus(row.status),
    facility: { id: row.facilityId, name: row.name, address: row.address ?? null },
    sourcePacketUrl,
    sourcePageCount: 0,
    reviewQueueCount,
    requirements: {
      documents,
      verifications,
      attestations,
      submission,
      privilegeDelineations,
    },
  };
}

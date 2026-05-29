import { db, schema, withTenancy } from "@cred/db";
import { and, eq } from "drizzle-orm";
import type { GqlContext } from "../context.js";
import { toFeDocumentType } from "../mappings.js";
import { mapExtractedFields } from "./caseDetail.js";
import { caseSummariesForProvider } from "./pipeline.js";
import type {
  DocumentSummaryGql,
  ProviderDocumentRowGql,
  ProviderProfileDetailGql,
} from "./types.js";

function expirationStatus(
  expiresAt: Date | null,
  now: Date = new Date(),
): "current" | "expiring_soon" | "expired" {
  if (!expiresAt) return "current";
  const ms = expiresAt.getTime() - now.getTime();
  if (ms < 0) return "expired";
  const days = ms / (1000 * 60 * 60 * 24);
  return days <= 60 ? "expiring_soon" : "current";
}

function mapExtractionStatus(
  status: string,
): "pending" | "processing" | "ready" | "failed" {
  switch (status) {
    case "running":
      return "processing";
    case "succeeded":
    case "needs_review":
      return "ready";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

export async function providerResolver(
  _src: unknown,
  args: { id: string },
  ctx: GqlContext,
): Promise<ProviderProfileDetailGql | null> {
  // The providers table is global per SPEC §5.1 — access is gated through
  // provider_workspace_grants. Verify the active workspace has a grant
  // before returning any data.
  // rls: bypass — the grant check IS the workspace gate; we verify it here.
  const [grant] = await db()
    .select({ providerId: schema.providerWorkspaceGrants.providerId })
    .from(schema.providerWorkspaceGrants)
    .where(
      and(
        eq(schema.providerWorkspaceGrants.providerId, args.id),
        eq(schema.providerWorkspaceGrants.workspaceId, ctx.tenancy.workspaceId),
      ),
    )
    .limit(1);
  if (!grant) return null;

  // rls: bypass — providers is global; we gated by grant above.
  const [prov] = await db()
    .select()
    .from(schema.providers)
    .where(eq(schema.providers.id, args.id))
    .limit(1);
  if (!prov) return null;

  // rls: bypass — documents belong to the provider, not the workspace.
  const documentRows = await db()
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.providerId, prov.id));

  // Count reuse via case usage of provider's docs within this workspace.
  // For simplicity: count cases for this provider within the workspace.
  const caseCount = await withTenancy(ctx.tenancy, async (tx) => {
    const rows = await tx
      .select({ id: schema.cases.id })
      .from(schema.cases)
      .where(eq(schema.cases.providerId, prov.id));
    return rows.length;
  });

  const documents: ProviderDocumentRowGql[] = documentRows.map(
    (d): ProviderDocumentRowGql => {
      const feType = toFeDocumentType(d.documentType) ?? "medical_license";
      const summary: DocumentSummaryGql = {
        id: d.id,
        type: feType,
        thumbnailUrl: null,
        pageCount: d.pageCount ?? 1,
        uploadedAt: d.uploadedAt.toISOString(),
        expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
        extractionStatus: mapExtractionStatus(d.extractionStatus),
        reusedFromPriorCase: false,
        extractedFields: mapExtractedFields(d.extractedFields),
      };
      return {
        document: summary,
        reuseCount: Math.max(0, caseCount - 1),
        expirationStatus: expirationStatus(d.expiresAt),
      };
    },
  );

  const cases = await caseSummariesForProvider(prov.id, ctx);

  return {
    id: prov.id,
    fullName: `${prov.firstName} ${prov.lastName}`.trim(),
    npi: prov.npi,
    email: prov.email,
    phone: prov.phone,
    dob: prov.dob ? String(prov.dob) : null,
    specialties: prov.specialties ?? [],
    statesLicensed: prov.statesLicensed ?? [],
    documents,
    cases,
  };
}

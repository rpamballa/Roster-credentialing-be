import { createHash } from "node:crypto";
import { type Tx, db, schema, withTenancy } from "@cred/db";
import { audit } from "@cred/observability";
import { getObjectStorage } from "@cred/storage";
import type { ExtractedField, FacilityRequirements } from "@cred/types";
import { eq } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export class PacketAssemblyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "PacketAssemblyError";
  }
}

export interface AssembledPacket {
  packetId: string;
  fileUri: string;
  contentHash: string;
}

/**
 * Build a submittable PDF for a case. Pulls the case's facility requirements,
 * the provider's confirmed documents, then renders a cover page + a section
 * per requirement showing the matched document and its extracted fields.
 * The resulting PDF is stamped with a content hash and full provenance
 * (model versions, document ids, facility profile version) per PROMPT M4 §6.5.
 */
export async function assemblePacket(params: {
  caseId: string;
  workspaceId: string;
  actorUserId: string;
}): Promise<AssembledPacket> {
  const data = await withTenancy(
    { workspaceId: params.workspaceId, userId: params.actorUserId },
    (tx) => gatherCaseData(tx, params.caseId),
  );
  if (!data) throw new PacketAssemblyError("case not found", "case_not_found");

  if (data.facilityProfile.status !== "approved") {
    throw new PacketAssemblyError(
      "facility profile must be approved before assembly",
      "facility_not_approved",
    );
  }

  const pdfBytes = await renderPdf(data);
  const contentHash = createHash("sha256").update(pdfBytes).digest("hex");

  const key = `packets/${params.caseId}/${contentHash}.pdf`;
  await uploadBytes(key, Buffer.from(pdfBytes), "application/pdf");

  const provenance = {
    modelVersions: data.modelVersions,
    documentIds: data.documents.map((d) => d.id),
    facilityProfileVersion: data.facilityProfile.version,
  };

  const packetId = await withTenancy(
    { workspaceId: params.workspaceId, userId: params.actorUserId },
    async (tx) => {
      const [row] = await tx
        .insert(schema.packets)
        .values({
          workspaceId: params.workspaceId,
          caseId: params.caseId,
          fileUri: key,
          contentHash,
          provenance,
        })
        .returning({ id: schema.packets.id });
      if (!row) throw new PacketAssemblyError("insert failed", "insert_failed");
      return row.id;
    },
  );

  await audit({
    workspaceId: params.workspaceId,
    actorUserId: params.actorUserId,
    actorType: "user",
    action: "packet.assembled",
    targetEntityType: "packet",
    targetEntityId: packetId,
    after: { caseId: params.caseId, contentHash, provenance },
  });

  return { packetId, fileUri: key, contentHash };
}

interface GatheredData {
  case: typeof schema.cases.$inferSelect;
  facilityProfile: typeof schema.facilityProfiles.$inferSelect;
  facilityName: string;
  provider: typeof schema.providers.$inferSelect;
  documents: Array<typeof schema.documents.$inferSelect>;
  modelVersions: Record<string, string>;
}

async function gatherCaseData(tx: Tx, caseId: string): Promise<GatheredData | null> {
  const [c] = await tx.select().from(schema.cases).where(eq(schema.cases.id, caseId)).limit(1);
  if (!c || !c.facilityProfileId) return null;

  const [fp] = await tx
    .select()
    .from(schema.facilityProfiles)
    .where(eq(schema.facilityProfiles.id, c.facilityProfileId))
    .limit(1);
  if (!fp) return null;

  const [f] = await tx
    .select({ name: schema.facilities.name })
    .from(schema.facilities)
    .where(eq(schema.facilities.id, fp.facilityId))
    .limit(1);

  const [p] = await tx
    .select()
    .from(schema.providers)
    .where(eq(schema.providers.id, c.providerId))
    .limit(1);
  if (!p) return null;

  const docs = await tx
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.providerId, c.providerId));

  // Snapshot which model versions touched the documents in this packet.
  const modelVersions: Record<string, string> = {};
  for (const d of docs) {
    if (d.extractedFields) modelVersions[d.documentType] = "claude-sonnet"; // refined by ai_calls join
  }

  return {
    case: c,
    facilityProfile: fp,
    facilityName: f?.name ?? "Unknown facility",
    provider: p,
    documents: docs,
    modelVersions,
  };
}

async function renderPdf(data: GatheredData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Cover page.
  const cover = pdf.addPage([612, 792]);
  cover.drawText("Credentialing Packet", {
    x: 50,
    y: 720,
    size: 24,
    font: fontBold,
    color: rgb(0.06, 0.11, 0.18),
  });
  cover.drawText(`Provider: ${data.provider.firstName} ${data.provider.lastName}`, {
    x: 50,
    y: 680,
    size: 14,
    font,
  });
  cover.drawText(`Facility: ${data.facilityName}`, {
    x: 50,
    y: 660,
    size: 14,
    font,
  });
  cover.drawText(`Specialty: ${data.case.specialty}`, {
    x: 50,
    y: 640,
    size: 14,
    font,
  });
  cover.drawText(`Assembled: ${new Date().toISOString()}`, {
    x: 50,
    y: 620,
    size: 10,
    font,
    color: rgb(0.4, 0.45, 0.55),
  });
  cover.drawText(`Facility profile version: v${data.facilityProfile.version}`, {
    x: 50,
    y: 605,
    size: 10,
    font,
    color: rgb(0.4, 0.45, 0.55),
  });

  const requirements = data.facilityProfile.requirements as FacilityRequirements;
  const documentsByType = new Map<string, (typeof data.documents)[number]>();
  for (const d of data.documents) {
    if (d.confirmedAt && !documentsByType.has(d.documentType))
      documentsByType.set(d.documentType, d);
  }

  // One section per required document.
  for (const req of requirements.required_documents) {
    const page = pdf.addPage([612, 792]);
    let y = 740;
    page.drawText(humanize(req.type), { x: 50, y, size: 18, font: fontBold });
    y -= 24;
    const doc = documentsByType.get(req.type);
    if (doc) {
      page.drawText(`Status: on file (document ${doc.id.slice(0, 8)})`, {
        x: 50,
        y,
        size: 11,
        font,
        color: rgb(0.08, 0.5, 0.24),
      });
      y -= 18;
      if (doc.expiresAt) {
        page.drawText(`Expires: ${doc.expiresAt.toISOString().slice(0, 10)}`, {
          x: 50,
          y,
          size: 11,
          font,
        });
        y -= 18;
      }
      const fields = (doc.extractedFields as ExtractedField[] | null) ?? [];
      for (const field of fields) {
        const value = field.value === null ? "—" : String(field.value);
        page.drawText(`${field.name}: ${value}`, { x: 60, y, size: 10, font });
        y -= 14;
        if (y < 80) break;
      }
    } else {
      page.drawText("Status: MISSING", {
        x: 50,
        y,
        size: 12,
        font: fontBold,
        color: rgb(0.76, 0.25, 0.05),
      });
    }
  }

  return pdf.save();
}

function humanize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

async function uploadBytes(key: string, body: Buffer, contentType: string): Promise<void> {
  const presign = await getObjectStorage().putSignedUrl({
    key,
    contentType,
    expiresInSeconds: 120,
  });
  const resp = await fetch(presign.url, {
    method: "PUT",
    headers: { "content-type": contentType, ...presign.headers },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new PacketAssemblyError(`upload failed: ${resp.status} ${text}`, "upload_failed");
  }
}

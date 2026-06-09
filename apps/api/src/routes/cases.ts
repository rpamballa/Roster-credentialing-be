// FE-shaped provider case routes — `/v1/cases/*`.
//
// These endpoints serve the provider mobile-web surface
// (`apps/web/app/(provider)/case/...`) directly. The BE is the FE's
// adapter: every response is shaped exactly as
// apps/web/lib/types/{case,document,reference}.ts defines them, so the
// FE never has to translate enums or remap fields.
//
// Tenancy/RLS: the existing `requireProviderAuth` + `requireProviderTenancy`
// middlewares bind a single workspace + case to the session. Every handler
// additionally calls `assertSessionOwnsCase(c)` to defensively pin the
// path `:caseId` to that session.

import { randomUUID } from "node:crypto";
import { db, schema, withTenancy } from "@cred/db";
import { audit } from "@cred/observability";
import { getObjectStorage } from "@cred/storage";
import type {
  DocumentType as BeDocumentType,
  ExtractedField,
  ExtractionStatus as BeExtractionStatus,
  CaseStatus as BeCaseStatus,
} from "@cred/types/domain";
import type { FacilityRequirements } from "@cred/types";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireProviderAuth } from "../middleware/session.js";
import { requireProviderTenancy } from "../middleware/tenancy.js";
import { advanceDocumentExtractionInline } from "../services/documentExtractionInline.js";
import type { ApiBindings } from "../types.js";
import { assertSessionOwnsCase } from "./_providerHelpers.js";

export const caseRoutes = new Hono<ApiBindings>();

caseRoutes.use("/v1/cases/*", requireProviderAuth, requireProviderTenancy);

// ─── shared shape adapters ───────────────────────────────────────────────
// Source of truth: docs/audits/be-provider-coverage.md §3.
//
// The FE has its own narrower enum vocabularies; the BE has the canonical
// ones. We translate BE → FE on the way out and FE → BE on the way in.

// FE DocumentType union (apps/web/lib/types/document.ts:9-19).
type FeDocumentType =
  | "medical_license"
  | "dea"
  | "board_certification"
  | "bls"
  | "acls"
  | "medical_diploma"
  | "government_id"
  | "vaccination"
  | "malpractice_insurance";

type FeExtractionStatus = "pending" | "processing" | "ready" | "failed";

type FeCaseStatus =
  | "intake"
  | "documents_pending"
  | "documents_review"
  | "references_pending"
  | "attestation_pending"
  | "ready_to_submit"
  | "submitted"
  | "active"
  | "closed";

const BE_TO_FE_DOC_TYPE: Partial<Record<BeDocumentType, FeDocumentType>> = {
  medical_license: "medical_license",
  dea: "dea",
  board_certification: "board_certification",
  bls: "bls",
  acls: "acls",
  medical_school_diploma: "medical_diploma",
  government_id: "government_id",
  vaccination_record: "vaccination",
  malpractice_insurance: "malpractice_insurance",
  // BE-only buckets — no FE counterpart, omit from FE responses.
  // cv, other
};

const FE_TO_BE_DOC_TYPE: Record<FeDocumentType, BeDocumentType> = {
  medical_license: "medical_license",
  dea: "dea",
  board_certification: "board_certification",
  bls: "bls",
  acls: "acls",
  medical_diploma: "medical_school_diploma",
  government_id: "government_id",
  vaccination: "vaccination_record",
  malpractice_insurance: "malpractice_insurance",
};

const BE_TO_FE_EXTRACTION_STATUS: Record<BeExtractionStatus, FeExtractionStatus> = {
  pending: "pending",
  running: "processing",
  succeeded: "ready",
  needs_review: "ready",
  failed: "failed",
};

const BE_TO_FE_CASE_STATUS: Record<BeCaseStatus, FeCaseStatus> = {
  intake: "intake",
  in_progress: "documents_review",
  awaiting_provider: "documents_pending",
  awaiting_references: "references_pending",
  ready_for_review: "ready_to_submit",
  submitted: "submitted",
  completed: "closed",
  withdrawn: "closed",
};

// Field name humanizer — produces the FE `label` from the canonical
// snake_case `name`. e.g. "license_number" → "License number".
function humanizeKey(key: string): string {
  if (!key) return "";
  const cleaned = key.replace(/[_-]+/g, " ").trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

interface FeExtractedField {
  key: string;
  label: string;
  value: string;
  confidence: number;
  bbox?: { page: number; bbox: [number, number, number, number] };
}

function projectExtractedFields(raw: ExtractedField[] | null | undefined): FeExtractedField[] | undefined {
  if (!raw) return undefined;
  return raw.map((f) => ({
    key: f.name,
    label: humanizeKey(f.name),
    value: f.value === null || f.value === undefined ? "" : String(f.value),
    confidence: f.confidence,
    bbox: { page: f.page, bbox: f.bbox },
  }));
}

interface FeDocumentSummary {
  id: string;
  type: FeDocumentType;
  thumbnailUrl: string | null;
  pageCount: number;
  uploadedAt: string;
  expiresAt: string | null;
  extractionStatus: FeExtractionStatus;
  extractedFields?: FeExtractedField[];
  reusedFromPriorCase: boolean;
}

interface DocumentRowLike {
  id: string;
  documentType: BeDocumentType;
  pageCount: number | null;
  uploadedAt: Date;
  expiresAt: Date | null;
  extractionStatus: BeExtractionStatus;
  extractedFields: ExtractedField[] | null;
  source: typeof schema.documents.$inferSelect.source;
}

/**
 * Project a BE `documents` row into the FE `DocumentSummary` shape. Returns
 * null when the BE document_type has no FE counterpart (cv / other) — the
 * FE has no slot for these.
 */
function projectDocumentSummary(d: DocumentRowLike): FeDocumentSummary | null {
  const feType = BE_TO_FE_DOC_TYPE[d.documentType];
  if (!feType) return null;
  const fields = projectExtractedFields(d.extractedFields);
  const base: FeDocumentSummary = {
    id: d.id,
    type: feType,
    thumbnailUrl: null,
    pageCount: d.pageCount ?? 1,
    uploadedAt: d.uploadedAt.toISOString(),
    expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
    extractionStatus: BE_TO_FE_EXTRACTION_STATUS[d.extractionStatus],
    // `source` is the only signal today; a future enum value
    // `reused_from_prior_case` would flip this directly.
    reusedFromPriorCase: false,
  };
  if (fields !== undefined) base.extractedFields = fields;
  return base;
}

// ─── error helpers ────────────────────────────────────────────────────────

function notFound(c: Parameters<typeof caseRoutes.post>[0] extends string ? never : never) {
  return c;
}

// ─── 6.4  POST /v1/cases/:caseId/documents/sign-upload ───────────────────
// Insert the documents row up-front with the FE-supplied type, sign a PUT
// URL keyed `uploads/<caseId>/<documentId>`, return SignedUploadTarget.
const SignUploadSchema = z.object({
  documentType: z.enum([
    "medical_license",
    "dea",
    "board_certification",
    "bls",
    "acls",
    "medical_diploma",
    "government_id",
    "vaccination",
    "malpractice_insurance",
  ]),
  mimeType: z.string().min(1).max(128),
  sizeBytes: z.number().int().nonnegative().max(64 * 1024 * 1024).optional(),
  originalFilename: z.string().min(1).max(255).optional(),
});

caseRoutes.post(
  "/v1/cases/:caseId/documents/sign-upload",
  zValidator("json", SignUploadSchema),
  async (c) => {
    const guard = assertSessionOwnsCase(c);
    if (guard) return guard;
    const auth = c.var.providerAuth;
    const tenancy = c.var.tenancy;
    const caseId = c.req.param("caseId");
    const body = c.req.valid("json");

    const documentId = randomUUID();
    const fileUri = `uploads/${caseId}/${documentId}`;

    const presign = await getObjectStorage().putSignedUrl({
      key: fileUri,
      contentType: body.mimeType,
      expiresInSeconds: 15 * 60,
    });

    const beDocumentType = FE_TO_BE_DOC_TYPE[body.documentType];

    await withTenancy(tenancy, async (tx) => {
      await tx
        .insert(schema.documents)
        .values({
          id: documentId,
          providerId: auth.session.providerId,
          documentType: beDocumentType,
          fileUri,
          originalFilename: body.originalFilename ?? null,
          mimeType: body.mimeType,
          source: "provider_upload",
          extractionStatus: "pending",
        });
    });

    await audit({
      workspaceId: tenancy.workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "document.upload_signed",
      targetEntityType: "document",
      targetEntityId: documentId,
      after: {
        providerId: auth.session.providerId,
        caseId,
        documentType: beDocumentType,
        source: "provider_upload",
      },
      requestId: c.var.requestId,
    });

    return c.json({
      documentId,
      uploadUrl: presign.url,
      headers: presign.headers,
      maxBytes: 25 * 1024 * 1024,
    });
  },
);

// ─── 6.5  POST /v1/cases/:caseId/documents/:docId/uploaded ───────────────
// Verify the object exists, flip to running, kick inline extraction, return
// a DocumentSummary with extractionStatus="processing".
const UploadedSchema = z
  .object({
    pageCount: z.number().int().positive().max(2000).optional(),
    originalFilename: z.string().max(255).optional(),
    mimeType: z.string().min(1).max(128).optional(),
  })
  .optional();

caseRoutes.post(
  "/v1/cases/:caseId/documents/:docId/uploaded",
  zValidator("json", UploadedSchema.transform((v) => v ?? {})),
  async (c) => {
    const guard = assertSessionOwnsCase(c);
    if (guard) return guard;
    const auth = c.var.providerAuth;
    const tenancy = c.var.tenancy;
    const docId = c.req.param("docId");
    const body = c.req.valid("json");

    const found = await withTenancy(tenancy, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.id, docId),
            eq(schema.documents.providerId, auth.session.providerId),
          ),
        )
        .limit(1);
      return row ?? null;
    });
    if (!found) {
      return c.json(
        { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
        404,
      );
    }

    const exists = await getObjectStorage().exists(found.fileUri);
    if (!exists) {
      return c.json(
        {
          type: "https://errors.cred/upload/missing",
          title: "Upload not found in object storage",
          status: 409,
          instance: c.var.requestId,
        },
        409,
      );
    }

    // Note: we intentionally do NOT flip extractionStatus to "running"
    // here — the inline service does it as step 1 of its lifecycle. If
    // we flipped here, the inline service's idempotency guard would skip
    // (it bails on `running | succeeded | needs_review`).
    const updates: Record<string, unknown> = {};
    if (body.pageCount) updates.pageCount = body.pageCount;
    if (body.mimeType) updates.mimeType = body.mimeType;
    if (body.originalFilename) updates.originalFilename = body.originalFilename;

    const [updated] = await withTenancy(tenancy, async (tx) => {
      if (Object.keys(updates).length === 0) {
        return tx
          .select()
          .from(schema.documents)
          .where(eq(schema.documents.id, docId))
          .limit(1);
      }
      return tx
        .update(schema.documents)
        .set(updates)
        .where(eq(schema.documents.id, docId))
        .returning();
    });
    if (!updated) {
      return c.json(
        { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
        404,
      );
    }

    await audit({
      workspaceId: tenancy.workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "document.uploaded",
      targetEntityType: "document",
      targetEntityId: docId,
      after: {
        providerId: auth.session.providerId,
        caseId: auth.session.caseId,
        documentType: updated.documentType,
        source: "provider_upload",
      },
      requestId: c.var.requestId,
    });

    // Fire-and-forget inline extraction. Hand the documentType through as
    // a hint so we skip the classifier when the FE already typed it.
    void advanceDocumentExtractionInline({
      documentId: docId,
      workspaceId: tenancy.workspaceId,
      documentTypeHint: updated.documentType,
    });

    const summary = projectDocumentSummary(updated);
    // The inline service will flip status to running asynchronously;
    // surface "processing" in the response so the FE poller starts in
    // the right state.
    const responseSummary = summary
      ? { ...summary, extractionStatus: "processing" as const }
      : {
          id: updated.id,
          type: "other" as unknown as FeDocumentType,
          thumbnailUrl: null,
          pageCount: updated.pageCount ?? 1,
          uploadedAt: updated.uploadedAt.toISOString(),
          expiresAt: updated.expiresAt ? updated.expiresAt.toISOString() : null,
          extractionStatus: "processing" as const,
          reusedFromPriorCase: false,
        };
    return c.json(responseSummary);
  },
);

// ─── 6.6  GET /v1/cases/:caseId/documents/:docId ─────────────────────────
caseRoutes.get("/v1/cases/:caseId/documents/:docId", async (c) => {
  const guard = assertSessionOwnsCase(c);
  if (guard) return guard;
  const auth = c.var.providerAuth;
  const tenancy = c.var.tenancy;
  const docId = c.req.param("docId");

  const doc = await withTenancy(tenancy, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.id, docId),
          eq(schema.documents.providerId, auth.session.providerId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  if (!doc) {
    return c.json(
      { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
      404,
    );
  }

  const summary = projectDocumentSummary(doc);
  if (!summary) {
    // Fall back to a synthetic FE shape — the FE rarely fetches these
    // bucket-types directly but we don't 404 a legitimate doc.
    return c.json({
      id: doc.id,
      type: doc.documentType,
      thumbnailUrl: null,
      pageCount: doc.pageCount ?? 1,
      uploadedAt: doc.uploadedAt.toISOString(),
      expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
      extractionStatus: BE_TO_FE_EXTRACTION_STATUS[doc.extractionStatus],
      extractedFields: projectExtractedFields(doc.extractedFields),
      reusedFromPriorCase: false,
    });
  }
  return c.json(summary);
});

// ─── 6.7  POST /v1/cases/:caseId/documents/:docId/confirm ────────────────
// Accept FE-shape fields; translate to canonical; persist; return updated
// DocumentSummary.
const ConfirmFeFieldSchema = z.object({
  key: z.string().min(1).max(128),
  label: z.string().max(256).optional(),
  value: z.string(),
  confidence: z.number().min(0).max(1),
  bbox: z
    .object({
      page: z.number().int().nonnegative(),
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    })
    .optional(),
});

const ConfirmSchema = z.object({
  fields: z.array(ConfirmFeFieldSchema).max(200),
});

caseRoutes.post(
  "/v1/cases/:caseId/documents/:docId/confirm",
  zValidator("json", ConfirmSchema),
  async (c) => {
    const guard = assertSessionOwnsCase(c);
    if (guard) return guard;
    const auth = c.var.providerAuth;
    const tenancy = c.var.tenancy;
    const docId = c.req.param("docId");
    const { fields: feFields } = c.req.valid("json");

    // FE → BE adapter (audit §3.3).
    const canonical: ExtractedField[] = feFields.map((f) => ({
      name: f.key,
      value: f.value,
      confidence: f.confidence,
      page: f.bbox?.page ?? 0,
      bbox: f.bbox?.bbox ?? [0, 0, 1, 0.1],
    }));

    const updated = await withTenancy(tenancy, async (tx) => {
      const [doc] = await tx
        .select()
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.id, docId),
            eq(schema.documents.providerId, auth.session.providerId),
          ),
        )
        .limit(1);
      if (!doc) return null;

      const [row] = await tx
        .update(schema.documents)
        .set({
          extractedFields: canonical,
          confirmedAt: new Date(),
          extractionStatus: "succeeded",
        })
        .where(eq(schema.documents.id, docId))
        .returning();
      return row ? { row, before: doc.extractedFields } : null;
    });

    if (!updated) {
      return c.json(
        { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
        404,
      );
    }

    await audit({
      workspaceId: tenancy.workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "document.confirmed",
      targetEntityType: "document",
      targetEntityId: updated.row.id,
      before: { extractedFields: updated.before },
      after: { extractedFields: canonical, providerId: auth.session.providerId },
      requestId: c.var.requestId,
    });

    const summary = projectDocumentSummary(updated.row);
    return c.json(
      summary ?? {
        id: updated.row.id,
        type: updated.row.documentType,
        thumbnailUrl: null,
        pageCount: updated.row.pageCount ?? 1,
        uploadedAt: updated.row.uploadedAt.toISOString(),
        expiresAt: updated.row.expiresAt ? updated.row.expiresAt.toISOString() : null,
        extractionStatus: "ready" as const,
        extractedFields: projectExtractedFields(updated.row.extractedFields),
        reusedFromPriorCase: false,
      },
    );
  },
);

// ─── 6.8  POST /v1/cases/:caseId/documents/reuse ─────────────────────────
const ReuseSchema = z.object({
  sourceDocumentId: z.string().uuid(),
  documentType: z
    .enum([
      "medical_license",
      "dea",
      "board_certification",
      "bls",
      "acls",
      "medical_diploma",
      "government_id",
      "vaccination",
      "malpractice_insurance",
    ])
    .optional(),
});

caseRoutes.post(
  "/v1/cases/:caseId/documents/reuse",
  zValidator("json", ReuseSchema),
  async (c) => {
    const guard = assertSessionOwnsCase(c);
    if (guard) return guard;
    const auth = c.var.providerAuth;
    const tenancy = c.var.tenancy;
    const { sourceDocumentId, documentType: feDocType } = c.req.valid("json");

    const inserted = await withTenancy(tenancy, async (tx) => {
      // Source row ownership: must belong to this provider.
      const [src] = await tx
        .select()
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.id, sourceDocumentId),
            eq(schema.documents.providerId, auth.session.providerId),
          ),
        )
        .limit(1);
      if (!src) return null;

      const beDocType: BeDocumentType = feDocType
        ? FE_TO_BE_DOC_TYPE[feDocType]
        : src.documentType;

      const [row] = await tx
        .insert(schema.documents)
        .values({
          providerId: auth.session.providerId,
          documentType: beDocType,
          fileUri: src.fileUri,
          contentHash: src.contentHash,
          originalFilename: src.originalFilename,
          mimeType: src.mimeType,
          pageCount: src.pageCount,
          source: "provider_upload",
          extractionStatus: "succeeded",
          extractedFields: src.extractedFields,
          extractedAt: new Date(),
          confirmedAt: new Date(),
          expiresAt: src.expiresAt,
          classifierConfidence: src.classifierConfidence,
        })
        .returning();
      return row ?? null;
    });

    if (!inserted) {
      return c.json(
        { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
        404,
      );
    }

    await audit({
      workspaceId: tenancy.workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "document.reused",
      targetEntityType: "document",
      targetEntityId: inserted.id,
      after: {
        providerId: auth.session.providerId,
        sourceDocumentId,
        caseId: auth.session.caseId,
      },
      requestId: c.var.requestId,
    });

    const summary = projectDocumentSummary(inserted);
    return c.json({
      ...(summary ?? {
        id: inserted.id,
        type: inserted.documentType,
        thumbnailUrl: null,
        pageCount: inserted.pageCount ?? 1,
        uploadedAt: inserted.uploadedAt.toISOString(),
        expiresAt: inserted.expiresAt ? inserted.expiresAt.toISOString() : null,
        extractionStatus: "ready" as const,
        extractedFields: projectExtractedFields(inserted.extractedFields),
        reusedFromPriorCase: true,
      }),
      reusedFromPriorCase: true,
    });
  },
);

// ─── 6.9  GET /v1/cases/:caseId/references ───────────────────────────────
type FeRelationship =
  | "department_chair"
  | "peer_physician"
  | "supervising_physician"
  | "training_director";
type FeReferenceStatus = "pending" | "sent" | "viewed" | "completed" | "declined";

interface FeReferenceSummary {
  id: string;
  fullName: string;
  email: string;
  organization: string;
  relationship: FeRelationship;
  status: FeReferenceStatus;
  completedAt: string | null;
}

function projectReference(r: typeof schema.references.$inferSelect): FeReferenceSummary {
  // Default to "peer_physician" when missing/unknown — FE union is closed,
  // but the seed sometimes uses ad-hoc strings.
  const allowed: FeRelationship[] = [
    "department_chair",
    "peer_physician",
    "supervising_physician",
    "training_director",
  ];
  const relationship = (allowed.includes(r.relationship as FeRelationship)
    ? (r.relationship as FeRelationship)
    : "peer_physician") as FeRelationship;
  const status: FeReferenceStatus = (() => {
    const s = (r.status ?? "pending").toLowerCase();
    if (s === "pending" || s === "sent" || s === "viewed" || s === "completed" || s === "declined") {
      return s;
    }
    return "pending";
  })();
  const organization =
    (r.responseFields && typeof (r.responseFields as Record<string, unknown>).organization === "string"
      ? ((r.responseFields as Record<string, unknown>).organization as string)
      : "") ?? "";
  return {
    id: r.id,
    fullName: r.name,
    email: r.email ?? "",
    organization,
    relationship,
    status,
    completedAt: r.respondedAt ? r.respondedAt.toISOString() : null,
  };
}

caseRoutes.get("/v1/cases/:caseId/references", async (c) => {
  const guard = assertSessionOwnsCase(c);
  if (guard) return guard;
  const tenancy = c.var.tenancy;
  const caseId = c.req.param("caseId");

  const rows = await withTenancy(tenancy, async (tx) => {
    return tx
      .select()
      .from(schema.references)
      .where(eq(schema.references.caseId, caseId));
  });

  return c.json(rows.map(projectReference));
});

// ─── 6.10  POST /v1/cases/:caseId/references ─────────────────────────────
const CreateReferenceSchema = z.object({
  fullName: z.string().min(1).max(256),
  email: z.string().email().max(256),
  organization: z.string().min(1).max(256),
  relationship: z.enum([
    "department_chair",
    "peer_physician",
    "supervising_physician",
    "training_director",
  ]),
});

caseRoutes.post(
  "/v1/cases/:caseId/references",
  zValidator("json", CreateReferenceSchema),
  async (c) => {
    const guard = assertSessionOwnsCase(c);
    if (guard) return guard;
    const tenancy = c.var.tenancy;
    const caseId = c.req.param("caseId");
    const body = c.req.valid("json");

    const inserted = await withTenancy(tenancy, async (tx) => {
      const [row] = await tx
        .insert(schema.references)
        .values({
          workspaceId: tenancy.workspaceId,
          caseId,
          name: body.fullName,
          email: body.email,
          relationship: body.relationship,
          status: "pending",
          responseFields: { organization: body.organization },
        })
        .returning();
      return row ?? null;
    });

    if (!inserted) {
      return c.json(
        {
          type: "about:blank",
          title: "Failed to create reference",
          status: 500,
          instance: c.var.requestId,
        },
        500,
      );
    }

    await audit({
      workspaceId: tenancy.workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "reference.invited",
      targetEntityType: "reference",
      targetEntityId: inserted.id,
      after: { caseId, organization: body.organization, relationship: body.relationship },
      requestId: c.var.requestId,
    });

    return c.json(projectReference(inserted));
  },
);

// ─── 6.11  DELETE /v1/cases/:caseId/references/:refId ────────────────────
caseRoutes.delete("/v1/cases/:caseId/references/:refId", async (c) => {
  const guard = assertSessionOwnsCase(c);
  if (guard) return guard;
  const tenancy = c.var.tenancy;
  const caseId = c.req.param("caseId");
  const refId = c.req.param("refId");

  const deleted = await withTenancy(tenancy, async (tx) => {
    const [row] = await tx
      .delete(schema.references)
      .where(
        and(
          eq(schema.references.id, refId),
          eq(schema.references.caseId, caseId),
          eq(schema.references.workspaceId, tenancy.workspaceId),
        ),
      )
      .returning({ id: schema.references.id });
    return row ?? null;
  });

  if (!deleted) {
    return c.json(
      { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
      404,
    );
  }

  await audit({
    workspaceId: tenancy.workspaceId,
    actorUserId: null,
    actorType: "agent",
    action: "reference.removed",
    targetEntityType: "reference",
    targetEntityId: deleted.id,
    after: { caseId },
    requestId: c.var.requestId,
  });

  return c.body(null, 204);
});

// ─── 6.12  POST /v1/cases/:caseId/ready ──────────────────────────────────
caseRoutes.post("/v1/cases/:caseId/ready", async (c) => {
  const guard = assertSessionOwnsCase(c);
  if (guard) return guard;
  const tenancy = c.var.tenancy;
  const caseId = c.req.param("caseId");

  const updated = await withTenancy(tenancy, async (tx) => {
    const [cs] = await tx
      .select({ id: schema.cases.id, status: schema.cases.status })
      .from(schema.cases)
      .where(eq(schema.cases.id, caseId))
      .limit(1);
    if (!cs) return { status: "not_found" as const };
    if (cs.status !== "awaiting_provider") {
      return { status: "conflict" as const, current: cs.status };
    }
    const [row] = await tx
      .update(schema.cases)
      .set({ status: "ready_for_review" })
      .where(eq(schema.cases.id, caseId))
      .returning({ id: schema.cases.id, status: schema.cases.status });
    return { status: "ok" as const, before: cs.status, after: row?.status };
  });

  if (updated.status === "not_found") {
    return c.json(
      { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
      404,
    );
  }
  if (updated.status === "conflict") {
    return c.json(
      {
        type: "https://errors.cred/case/invalid-state",
        title: `Case is in ${updated.current}, not awaiting_provider`,
        status: 409,
        instance: c.var.requestId,
      },
      409,
    );
  }

  await audit({
    workspaceId: tenancy.workspaceId,
    actorUserId: null,
    actorType: "agent",
    action: "case.marked_ready_by_provider",
    targetEntityType: "case",
    targetEntityId: caseId,
    before: { status: updated.before },
    after: { status: updated.after },
    requestId: c.var.requestId,
  });

  return c.json({ ok: true, status: "ready_to_submit" as FeCaseStatus });
});

// ─── 6.13  POST /v1/cases/:caseId/attestation/sign (stub) ────────────────
const SignAttestationSchema = z
  .object({
    returnUrl: z.string().url().optional(),
  })
  .optional();

caseRoutes.post(
  "/v1/cases/:caseId/attestation/sign",
  zValidator("json", SignAttestationSchema.transform((v) => v ?? {})),
  async (c) => {
    const guard = assertSessionOwnsCase(c);
    if (guard) return guard;
    const tenancy = c.var.tenancy;
    const caseId = c.req.param("caseId");

    // STUB — DocuSign integration intentionally deferred per audit
    // constraints. Returns a fake `signingUrl` + `envelopeId` so the FE
    // renders the redirect path end-to-end.
    const envelopeId = "stub";
    const signingUrl = "https://example.com/sign?envelope=stub";

    await audit({
      workspaceId: tenancy.workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "attestation.sign_requested_stub",
      targetEntityType: "case",
      targetEntityId: caseId,
      after: { envelopeId, signingUrl },
      requestId: c.var.requestId,
    });

    return c.json({ signingUrl, envelopeId });
  },
);

// ─── 6.14  GET /v1/cases/:caseId — the keystone ──────────────────────────

interface FeCaseStep {
  kind: "welcome" | "document" | "references" | "attestation" | "review" | "submitted";
  index: number;
  label: string;
  complete: boolean;
  documentType?: FeDocumentType;
}

interface FeRequiredDocSlot {
  type: FeDocumentType;
  reusable?: FeDocumentSummary;
  current?: FeDocumentSummary;
}

interface FeCaseState {
  id: string;
  status: FeCaseStatus;
  assignment: {
    facilityName: string;
    workspaceName: string;
    specialty: string;
    targetSubmissionDate: string | null;
  };
  providerFirstName: string;
  steps: FeCaseStep[];
  requiredDocuments: FeRequiredDocSlot[];
  references: FeReferenceSummary[];
  attestation: { required: boolean; signed: boolean; signingUrl?: string };
}

caseRoutes.get("/v1/cases/:caseId", async (c) => {
  const guard = assertSessionOwnsCase(c);
  if (guard) return guard;
  const auth = c.var.providerAuth;
  const tenancy = c.var.tenancy;
  const caseId = c.req.param("caseId");

  // 1-7. Bulk read in one withTenancy tx.
  const data = await withTenancy(tenancy, async (tx) => {
    const [caseRow] = await tx
      .select()
      .from(schema.cases)
      .where(eq(schema.cases.id, caseId))
      .limit(1);
    if (!caseRow) return null;

    // All this provider's documents, newest first.
    const docs = await tx
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.providerId, caseRow.providerId))
      .orderBy(desc(schema.documents.uploadedAt));

    const refs = await tx
      .select()
      .from(schema.references)
      .where(eq(schema.references.caseId, caseId));

    const atts = await tx
      .select()
      .from(schema.attestations)
      .where(eq(schema.attestations.caseId, caseId));

    return { caseRow, docs, refs, atts };
  });

  if (!data) {
    return c.json(
      { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
      404,
    );
  }

  // Provider name + workspace name + facility name lookups bypass
  // tenancy — providers/facilities are global tables; workspace lookup
  // is bounded by the session's workspaceId so no leak risk.
  // rls: bypass — global lookup tables; identifiers come from the
  // session-bound case row, not user input.
  const [providerRow] = await db()
    .select({ firstName: schema.providers.firstName })
    .from(schema.providers)
    .where(eq(schema.providers.id, data.caseRow.providerId))
    .limit(1);

  const [workspaceRow] = await db()
    .select({ name: schema.workspaces.name })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, tenancy.workspaceId))
    .limit(1);

  let facilityName = "";
  let requirements: FacilityRequirements | null = null;
  if (data.caseRow.facilityProfileId) {
    const [profileRow] = await db()
      .select({
        facilityId: schema.facilityProfiles.facilityId,
        requirements: schema.facilityProfiles.requirements,
      })
      .from(schema.facilityProfiles)
      .where(eq(schema.facilityProfiles.id, data.caseRow.facilityProfileId))
      .limit(1);
    if (profileRow) {
      requirements = profileRow.requirements as FacilityRequirements;
      const [fac] = await db()
        .select({ name: schema.facilities.name })
        .from(schema.facilities)
        .where(eq(schema.facilities.id, profileRow.facilityId))
        .limit(1);
      facilityName = fac?.name ?? "";
    }
  }

  // ── Build requiredDocuments ──────────────────────────────────────────
  // For each facility-required document type, pick the most recent doc the
  // provider has of that BE-translated type and decide current vs reusable
  // (by uploadedAt vs caseRow.openedAt).
  const requiredDocuments: FeRequiredDocSlot[] = [];
  const reqDocs = requirements?.required_documents ?? [];
  for (const req of reqDocs) {
    const feType = BE_TO_FE_DOC_TYPE[req.type];
    if (!feType) continue;
    // Match against the BE type we'd actually store under.
    const beType = FE_TO_BE_DOC_TYPE[feType];
    const candidates = data.docs.filter((d) => d.documentType === beType);
    // newest first thanks to docs orderBy desc(uploadedAt).
    const latest = candidates[0];
    const slot: FeRequiredDocSlot = { type: feType };
    if (latest) {
      const summary = projectDocumentSummary(latest);
      if (summary) {
        const isCurrent = latest.uploadedAt.getTime() >= data.caseRow.openedAt.getTime();
        if (isCurrent) {
          slot.current = summary;
        } else {
          slot.reusable = summary;
        }
      }
    }
    requiredDocuments.push(slot);
  }

  // ── Build steps ─────────────────────────────────────────────────────
  const attestationRequired = (requirements?.attestations.length ?? 0) > 0;
  const refsRequired = data.refs.length > 0 || attestationRequired;
  const refsComplete =
    data.refs.length > 0 && data.refs.every((r) => (r.status ?? "").toLowerCase() === "completed");
  const attestationSigned =
    data.atts.length > 0 &&
    data.atts.every((a) => (a.status ?? "").toLowerCase() === "completed");
  const isSubmitted =
    data.caseRow.status === "submitted" ||
    data.caseRow.status === "completed" ||
    data.caseRow.status === "withdrawn";

  const steps: FeCaseStep[] = [];
  let idx = 1;
  steps.push({ kind: "welcome", index: idx++, label: "Welcome", complete: true });
  for (const slot of requiredDocuments) {
    steps.push({
      kind: "document",
      index: idx++,
      label: `Upload ${slot.type.replace(/_/g, " ")}`,
      complete: !!slot.current && slot.current.extractionStatus === "ready",
      documentType: slot.type,
    });
  }
  if (refsRequired) {
    steps.push({
      kind: "references",
      index: idx++,
      label: "References",
      complete: refsComplete,
    });
  }
  if (attestationRequired) {
    steps.push({
      kind: "attestation",
      index: idx++,
      label: "Attestation",
      complete: attestationSigned,
    });
  }
  steps.push({ kind: "submitted", index: idx++, label: "Submitted", complete: isSubmitted });

  const out: FeCaseState = {
    id: data.caseRow.id,
    status: BE_TO_FE_CASE_STATUS[data.caseRow.status],
    assignment: {
      facilityName,
      workspaceName: workspaceRow?.name ?? "",
      specialty: data.caseRow.specialty,
      targetSubmissionDate: data.caseRow.targetSubmissionDate ?? null,
    },
    providerFirstName: providerRow?.firstName ?? "",
    steps,
    requiredDocuments,
    references: data.refs.map(projectReference),
    attestation: {
      required: attestationRequired,
      signed: attestationSigned,
    },
  };

  return c.json(out);
});

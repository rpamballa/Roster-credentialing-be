import type Anthropic from "@anthropic-ai/sdk";
import type { FacilityRequirements } from "@cred/types";
import { DOCUMENT_TYPES, VERIFICATION_TYPES } from "@cred/types/domain";
import { z } from "zod";
import { anthropicCall } from "./client.js";

// Zod mirror of FacilityRequirements (SPEC §5.3 / contract-locked).
// Kept in sync with packages/types/src/facility-requirements.ts. Any change
// to the type requires an ADR + migration (PROMPT §4.6).
const BboxCitation = z.object({
  page: z.number().int().nonnegative(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});

// Every top-level field defaults to a sensible empty. This keeps
// Claude's "I found nothing extractable" case (a tool call with `{}`
// or with only some fields populated) from failing the whole ingest.
// The admin can fill missing sections in on the review screen —
// matches the existing error-card copy: "you can enter the requirements
// manually after creating the facility".
const DEFAULT_SUBMISSION = { method: "platform" as const };

const RequirementsSchema = z.object({
  required_documents: z
    .array(
      z.object({
        type: z.enum(DOCUMENT_TYPES),
        count: z.number().int().positive(),
        conditions: z.array(z.string()).optional(),
        attestation_required: z.boolean(),
        bbox_citation: BboxCitation.optional(),
      }),
    )
    .default([]),
  required_verifications: z
    .array(
      z.object({
        type: z.enum(VERIFICATION_TYPES),
        source_priority: z.array(z.enum(["state_board", "npdb", "abms", "manual"])),
        recency_days: z.number().int().positive(),
        bbox_citation: BboxCitation.optional(),
      }),
    )
    .default([]),
  privilege_delineations: z
    .array(
      z.object({
        specialty: z.string(),
        privileges: z.array(
          z.object({
            name: z.string(),
            requires_volume: z.boolean(),
            threshold: z
              .object({
                count: z.number().int().nonnegative(),
                period_months: z.number().int().positive(),
              })
              .optional(),
          }),
        ),
      }),
    )
    .default([]),
  attestations: z
    .array(
      z.object({
        text: z.string(),
        signer_role: z.enum(["provider", "department_chair", "medical_director"]),
        format: z.enum(["checkbox", "signature", "initials"]),
      }),
    )
    .default([]),
  submission: z
    .object({
      method: z.enum(["platform", "email", "fax", "portal"]),
      recipient: z.string().optional(),
      deadline_days_before_effective: z.number().int().nonnegative().optional(),
    })
    .default(DEFAULT_SUBMISSION),
  facility_forms: z
    .array(
      z.object({
        form_id: z.string(),
        name: z.string(),
        source_uri: z.string(),
        field_mappings: z.record(z.string(), z.string()),
      }),
    )
    .default([]),
});

const SYSTEM = `You are a hospital privileging packet analyst. Given the full
packet (which may be multiple pages), produce a structured
FacilityRequirements object describing every requirement the facility
imposes on credentialed providers.

Facilities send two different kinds of documents. Both are valid input:

1. EXPLICIT REQUIREMENTS PACKETS — delineations of privileges, medical
   staff bylaws, credentialing checklists — that state directly what
   documents, verifications, and privileges are required.

2. APPLICATION FORMS — the blank forms that providers fill in as PART
   of applying for privileges. The requirements are IMPLICIT: a form
   field asking for a specific document number implies the facility
   requires that document. A disclosure question with a signature
   block implies an attestation. Small and mid-size facilities often
   send only their application form because the requirements list
   lives inside it.

Rules:

- For EXPLICIT REQUIREMENTS PACKETS — extract the stated requirements
  directly.

- For APPLICATION FORMS — INFER requirements from what the form asks
  the applicant to submit. Map common form fields to the tool's enum
  values, e.g.:
    * "State Medical License Number", "License Number(s)" → required_documents.medical_license
    * "DEA Registration Number" (+ any DEA expiration/schedule field) → required_documents.dea
    * "Board Certification" (+ specialty/subspecialty) → required_documents.board_certification
    * "NPI Number" → required_verifications.npi (source_priority: ["manual"] is fine when explicit source isn't named)
    * "Medical School", "Diploma", "Graduation Date" → required_documents.medical_diploma
    * "Malpractice Insurance", "Carrier / Policy / Coverage / Expiration" → required_documents.malpractice_insurance
    * "BLS/ACLS" certifications → required_documents.bls / .acls
    * "Vaccination"/"Immunization Record" → required_documents.vaccination
    * "SSN", "Government ID", "Driver's License" → required_documents.government_id
    * A references section asking for N professional references → required_verifications with type "professional_references" (or nearest enum) and source_priority ["manual"]
    * A malpractice-history / disciplinary-action / criminal-conviction question with an accompanying signature line → attestations, format "signature", signer_role "provider"
    * The physician certification / signature block at the end → attestations, format "signature", signer_role "provider"
    * A "Submission Instructions" paragraph naming a channel → submission (method: platform / email / fax / portal, recipient if named)

- Cite every extracted field with a bbox_citation pointing to the page
  and region where the requirement appears in the source packet. When
  bbox citations aren't available (Word document text extraction
  path), omit them — an empty bbox_citation is fine, do not fabricate
  coordinates.

- Use ONLY the enum values listed in the tool schema. If a packet uses
  a synonym (e.g., "Driver's License" → government_id), map it to the
  closest enum value rather than dropping the field.

- Conservative bias: if a requirement is truly ambiguous — you cannot
  tell whether it's required at all — mark it attestation_required=true
  and add a "review:<reason>" condition rather than inventing
  structure that isn't on the page. But do NOT return an empty result
  just because the input is a form and not a bylaws packet — a form
  IS the requirements.

- Bounding boxes, when present, are normalized to [0,1] page coordinates.`;

export interface FacilityParseParams {
  /** Image URLs — used for image-based packets (one per page). Mutually
   *  compatible with `packetDocument`; both can be provided. */
  packetImageUrls?: string[];
  /** PDF supplied as base64 + media type. Anthropic processes it natively
   *  via the `document` content block (no client-side page splitting). */
  packetDocument?: { base64: string; mediaType: "application/pdf" };
  /** Plain-text packet contents — used when the input arrived as a Word
   *  document (`.docx`) and was text-extracted via mammoth before reaching
   *  the parser. Loses layout + bboxes; the model gets no citations back
   *  into the source, so `bbox_citation` fields in the output will be
   *  absent. Acceptable for beta text-heavy compliance docs. */
  packetText?: string;
  workspaceId: string;
  /** Generic ledger linkage — replaces the older `sourceEmailId`-only form so
   *  the parser can be driven from any source (email-in, direct upload, …). */
  relatedEntity?: { type: string; id: string };
  /** Back-compat shim for callers that still pass an inbound-email id. */
  sourceEmailId?: string;
}

export async function parseFacilityPacket(
  params: FacilityParseParams,
): Promise<FacilityRequirements> {
  const userContent: Anthropic.MessageParam["content"] = [
    ...(params.packetImageUrls ?? []).map((url) => ({
      type: "image" as const,
      source: { type: "url" as const, url },
    })),
    ...(params.packetDocument
      ? [
          {
            type: "document" as const,
            source: {
              type: "base64" as const,
              media_type: params.packetDocument.mediaType,
              data: params.packetDocument.base64,
            },
          },
        ]
      : []),
    ...(params.packetText
      ? [
          {
            type: "text" as const,
            text: `Packet contents (extracted from a Word document — no page layout available, so bbox_citation fields will be absent):\n\n${params.packetText}`,
          },
        ]
      : []),
    {
      type: "text" as const,
      text: "Parse this facility privileging packet. Call extract_requirements with the structured output.",
    },
  ];

  if (
    (!params.packetImageUrls || params.packetImageUrls.length === 0) &&
    !params.packetDocument &&
    !params.packetText
  ) {
    throw new Error("parseFacilityPacket requires packetImageUrls, packetDocument, or packetText");
  }

  const relatedEntity =
    params.relatedEntity ??
    (params.sourceEmailId ? { type: "inbound_email", id: params.sourceEmailId } : undefined);

  const { output } = await anthropicCall({
    task: "facility.parse",
    model: "opus",
    systemPrompt: SYSTEM,
    userContent,
    tools: [
      {
        name: "extract_requirements",
        description: "Return the structured FacilityRequirements object.",
        input_schema: REQUIREMENTS_JSON_SCHEMA,
      },
    ],
    toolChoice: { type: "tool", name: "extract_requirements" },
    expectedSchema: RequirementsSchema,
    workspaceId: params.workspaceId,
    ...(relatedEntity ? { relatedEntity } : {}),
    maxTokens: 8192,
  });

  return output as FacilityRequirements;
}

// JSON Schema mirror used as the tool input schema. Kept narrow on purpose —
// Anthropic's structured output works best when the schema is precise.
const REQUIREMENTS_JSON_SCHEMA = {
  type: "object",
  properties: {
    required_documents: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...DOCUMENT_TYPES] },
          count: { type: "integer", minimum: 1 },
          conditions: { type: "array", items: { type: "string" } },
          attestation_required: { type: "boolean" },
          bbox_citation: bboxSchema(),
        },
        required: ["type", "count", "attestation_required"],
      },
    },
    required_verifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...VERIFICATION_TYPES] },
          source_priority: {
            type: "array",
            items: { type: "string", enum: ["state_board", "npdb", "abms", "manual"] },
          },
          recency_days: { type: "integer", minimum: 1 },
          bbox_citation: bboxSchema(),
        },
        required: ["type", "source_priority", "recency_days"],
      },
    },
    privilege_delineations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          specialty: { type: "string" },
          privileges: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                requires_volume: { type: "boolean" },
                threshold: {
                  type: "object",
                  properties: {
                    count: { type: "integer", minimum: 0 },
                    period_months: { type: "integer", minimum: 1 },
                  },
                  required: ["count", "period_months"],
                },
              },
              required: ["name", "requires_volume"],
            },
          },
        },
        required: ["specialty", "privileges"],
      },
    },
    attestations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          signer_role: {
            type: "string",
            enum: ["provider", "department_chair", "medical_director"],
          },
          format: { type: "string", enum: ["checkbox", "signature", "initials"] },
        },
        required: ["text", "signer_role", "format"],
      },
    },
    submission: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["platform", "email", "fax", "portal"] },
        recipient: { type: "string" },
        deadline_days_before_effective: { type: "integer", minimum: 0 },
      },
      required: ["method"],
    },
    facility_forms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          form_id: { type: "string" },
          name: { type: "string" },
          source_uri: { type: "string" },
          field_mappings: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["form_id", "name", "source_uri", "field_mappings"],
      },
    },
  },
  required: [
    "required_documents",
    "required_verifications",
    "privilege_delineations",
    "attestations",
    "submission",
    "facility_forms",
  ],
} as const;

function bboxSchema() {
  return {
    type: "object",
    properties: {
      page: { type: "integer", minimum: 0 },
      bbox: {
        type: "array",
        items: { type: "number", minimum: 0, maximum: 1 },
        minItems: 4,
        maxItems: 4,
      },
    },
    required: ["page", "bbox"],
  } as const;
}

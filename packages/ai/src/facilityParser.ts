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

const RequirementsSchema = z.object({
  required_documents: z.array(
    z.object({
      type: z.enum(DOCUMENT_TYPES),
      count: z.number().int().positive(),
      conditions: z.array(z.string()).optional(),
      attestation_required: z.boolean(),
      bbox_citation: BboxCitation.optional(),
    }),
  ),
  required_verifications: z.array(
    z.object({
      type: z.enum(VERIFICATION_TYPES),
      source_priority: z.array(z.enum(["state_board", "npdb", "abms", "manual"])),
      recency_days: z.number().int().positive(),
      bbox_citation: BboxCitation.optional(),
    }),
  ),
  privilege_delineations: z.array(
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
  ),
  attestations: z.array(
    z.object({
      text: z.string(),
      signer_role: z.enum(["provider", "department_chair", "medical_director"]),
      format: z.enum(["checkbox", "signature", "initials"]),
    }),
  ),
  submission: z.object({
    method: z.enum(["platform", "email", "fax", "portal"]),
    recipient: z.string().optional(),
    deadline_days_before_effective: z.number().int().nonnegative().optional(),
  }),
  facility_forms: z.array(
    z.object({
      form_id: z.string(),
      name: z.string(),
      source_uri: z.string(),
      field_mappings: z.record(z.string(), z.string()),
    }),
  ),
});

const SYSTEM = `You are a hospital privileging packet analyst. Given the full
packet (multiple pages), produce a structured FacilityRequirements object
describing every requirement the facility imposes on credentialed providers.

Rules:
- Cite every extracted field with a bbox_citation pointing to the page and
  region where the requirement appears in the source packet.
- Use ONLY the enum values listed in the tool schema. If a packet uses a
  synonym (e.g., "Driver's License"), map it to the closest enum value.
- Conservative bias: if a requirement is ambiguous, mark it
  attestation_required=true and add a "review:<reason>" condition rather than
  inventing structure that isn't on the page.
- Bounding boxes are normalized to [0,1] page coordinates.`;

export interface FacilityParseParams {
  /** Image URLs — used for image-based packets (one per page). Mutually
   *  compatible with `packetDocument`; both can be provided. */
  packetImageUrls?: string[];
  /** PDF supplied as base64 + media type. Anthropic processes it natively
   *  via the `document` content block (no client-side page splitting). */
  packetDocument?: { base64: string; mediaType: "application/pdf" };
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
    {
      type: "text" as const,
      text: "Parse this facility privileging packet. Call extract_requirements with the structured output.",
    },
  ];

  if (
    (!params.packetImageUrls || params.packetImageUrls.length === 0) &&
    !params.packetDocument
  ) {
    throw new Error("parseFacilityPacket requires packetImageUrls or packetDocument");
  }

  const relatedEntity =
    params.relatedEntity ??
    (params.sourceEmailId
      ? { type: "inbound_email", id: params.sourceEmailId }
      : undefined);

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

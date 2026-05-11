import type { DocumentType, ExtractedField } from "@cred/types/domain";
import { ExtractedFieldsSchema } from "@cred/types/domain";
import { z } from "zod";
import { anthropicCall } from "../client.js";

const ExtractResultSchema = z.object({
  fields: ExtractedFieldsSchema,
  notes: z.string().max(2000).optional(),
});
export type ExtractResult = z.infer<typeof ExtractResultSchema>;

export interface ExtractorSpec {
  documentType: DocumentType;
  /** Human-readable list of required field names for this doc type. */
  expectedFields: ReadonlyArray<string>;
  /** Per-type instructions appended to the shared system prompt. */
  typeGuidance: string;
}

const BASE_SYSTEM = `You are a credentialing-document extraction expert.
Given one or more page images, extract the structured fields requested for
this document type. For every field you return:

- value:      the extracted value, or null if the field is not present
- confidence: your confidence the value is correct, in [0,1]
- page:       the page index (0-based) the value came from
- bbox:       a normalized [x, y, w, h] bounding box in [0,1]

Return ONLY by calling the extract_fields tool. Never invent data — emit
null with low confidence when uncertain.`;

export interface ExtractParams {
  spec: ExtractorSpec;
  imageUrls: string[];
  workspaceId?: string | null;
  documentId?: string;
}

export async function runExtractor(params: ExtractParams): Promise<ExtractedField[]> {
  const userContent = [
    ...params.imageUrls.map((url) => ({
      type: "image" as const,
      source: { type: "url" as const, url },
    })),
    {
      type: "text" as const,
      text: `Document type: ${params.spec.documentType}.
Expected fields: ${params.spec.expectedFields.join(", ")}.

${params.spec.typeGuidance}

Call extract_fields with one entry per expected field (use value=null when
the field is missing). Do not return any other top-level fields.`,
    },
  ];

  const result = await anthropicCall({
    task: `extract.${params.spec.documentType}`,
    model: "sonnet",
    systemPrompt: BASE_SYSTEM,
    userContent,
    tools: [
      {
        name: "extract_fields",
        description: "Return the extracted fields for the document.",
        input_schema: {
          type: "object",
          properties: {
            fields: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  value: { type: ["string", "number", "boolean", "null"] },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  page: { type: "integer", minimum: 0 },
                  bbox: {
                    type: "array",
                    items: { type: "number", minimum: 0, maximum: 1 },
                    minItems: 4,
                    maxItems: 4,
                  },
                },
                required: ["name", "value", "confidence", "page", "bbox"],
              },
            },
            notes: { type: "string" },
          },
          required: ["fields"],
        },
      },
    ],
    toolChoice: { type: "tool", name: "extract_fields" },
    expectedSchema: ExtractResultSchema,
    workspaceId: params.workspaceId ?? null,
    ...(params.documentId ? { relatedEntity: { type: "document", id: params.documentId } } : {}),
  });
  return result.output.fields;
}

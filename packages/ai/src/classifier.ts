import type Anthropic from "@anthropic-ai/sdk";
import type { DocumentType } from "@cred/types/domain";
import { DOCUMENT_TYPES } from "@cred/types/domain";
import { z } from "zod";
import { anthropicCall } from "./client.js";
import { contentBlock, type DocumentContent } from "./extractors/base.js";

const ClassifyResult = z.object({
  document_type: z.enum([...DOCUMENT_TYPES] as [DocumentType, ...DocumentType[]]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(2000).optional(),
});
export type ClassifyResult = z.infer<typeof ClassifyResult>;

const SYSTEM = `You are a medical credentialing document classifier. Given an
image (or PDF) of a single page from a credentialing packet, identify which
type of document it is. Always return a confidence in [0,1]. Use "other" if
the document does not match any known type.`;

export interface ClassifyParams {
  /** Inline base64 + mediaType. Anthropic only accepts HTTPS URLs, so when
   *  the bytes live on an internal http://minio:9000 URL the caller must
   *  download them and pass them inline. */
  content: DocumentContent;
  workspaceId?: string | null;
  documentId?: string;
}

export async function classifyDocument(params: ClassifyParams): Promise<ClassifyResult> {
  const userContent: Anthropic.MessageParam["content"] = [
    contentBlock(params.content),
    {
      type: "text" as const,
      text: "Classify this credentialing document. Respond by calling the classify_document tool.",
    },
  ];
  const result = await anthropicCall({
    task: "document.classify",
    model: "sonnet",
    systemPrompt: SYSTEM,
    userContent,
    tools: [
      {
        name: "classify_document",
        description: "Return the document type and confidence.",
        input_schema: {
          type: "object",
          properties: {
            document_type: { type: "string", enum: [...DOCUMENT_TYPES] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reasoning: { type: "string" },
          },
          required: ["document_type", "confidence"],
        },
      },
    ],
    toolChoice: { type: "tool", name: "classify_document" },
    expectedSchema: ClassifyResult,
    workspaceId: params.workspaceId ?? null,
    ...(params.documentId ? { relatedEntity: { type: "document", id: params.documentId } } : {}),
  });
  return result.output;
}

import type { FacilityRequirements, RequiredDocument } from "@cred/types";
import type { DocumentType, ExtractedField } from "@cred/types/domain";
import { DOCUMENT_TYPES, VERIFICATION_TYPES } from "@cred/types/domain";
import { z } from "zod";
import { anthropicCall } from "./client.js";

// What a case currently has on file. The caller assembles this from the
// database before invoking the reasoner.
export interface CaseEvidence {
  provider: {
    firstName: string;
    lastName: string;
    specialties: string[];
    statesLicensed: string[];
  };
  documents: Array<{
    id: string;
    documentType: DocumentType;
    confirmedAt: Date | null;
    expiresAt: Date | null;
    fields: ExtractedField[] | null;
  }>;
  verifications: Array<{
    type: string;
    verifiedAt: Date | null;
  }>;
}

const ResultSchema = z.object({
  missing: z.array(
    z.object({
      kind: z.enum(["document", "verification", "attestation"]),
      type: z.string(),
      reason: z.string(),
      severity: z.enum(["blocker", "warning"]),
      remedy: z.string().optional(),
    }),
  ),
  expiring_soon: z.array(
    z.object({
      documentId: z.string(),
      documentType: z.enum(DOCUMENT_TYPES),
      expiresAt: z.string(),
      daysUntilExpiry: z.number().int(),
    }),
  ),
});

export type MissingDocsResult = z.infer<typeof ResultSchema>;

const SYSTEM = `You are a credentialing requirements reasoner. You are given:
- the facility's structured requirements
- the provider's documents and verifications already on file

Return what is MISSING or EXPIRING for the case to be submittable. Be
conservative — when in doubt, mark missing rather than satisfied. Distinguish
"blocker" (cannot submit) from "warning" (should escalate). Cite the
requirement type, not free-form prose.

Output ONLY by calling the report_missing tool.`;

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    missing: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["document", "verification", "attestation"] },
          type: { type: "string" },
          reason: { type: "string" },
          severity: { type: "string", enum: ["blocker", "warning"] },
          remedy: { type: "string" },
        },
        required: ["kind", "type", "reason", "severity"],
      },
    },
    expiring_soon: {
      type: "array",
      items: {
        type: "object",
        properties: {
          documentId: { type: "string" },
          documentType: { type: "string", enum: [...DOCUMENT_TYPES] },
          expiresAt: { type: "string" },
          daysUntilExpiry: { type: "integer" },
        },
        required: ["documentId", "documentType", "expiresAt", "daysUntilExpiry"],
      },
    },
  },
  required: ["missing", "expiring_soon"],
} as const;

export interface MissingDocsParams {
  requirements: FacilityRequirements;
  evidence: CaseEvidence;
  workspaceId: string;
  caseId?: string;
}

export async function reasonMissingDocs(params: MissingDocsParams): Promise<MissingDocsResult> {
  // Deterministic prefilter: if a required_documents entry has no matching
  // confirmed document for the provider, prepopulate a "missing" item. The
  // model still has the chance to add nuance and to spot
  // verification/attestation gaps that aren't a simple presence check.
  const deterministic = prefilter(params.requirements, params.evidence);

  const { output } = await anthropicCall({
    task: "case.missing_docs",
    model: "opus",
    systemPrompt: SYSTEM,
    userContent: [
      {
        type: "text",
        text: `Provider: ${params.evidence.provider.firstName} ${params.evidence.provider.lastName}
Specialties: ${params.evidence.provider.specialties.join(", ")}
States licensed: ${params.evidence.provider.statesLicensed.join(", ")}

Requirements (JSON):
${JSON.stringify(params.requirements, null, 2)}

On-file documents (JSON):
${JSON.stringify(
  params.evidence.documents.map((d) => ({
    id: d.id,
    type: d.documentType,
    confirmed: !!d.confirmedAt,
    expiresAt: d.expiresAt?.toISOString() ?? null,
  })),
  null,
  2,
)}

Completed verifications: ${params.evidence.verifications.map((v) => v.type).join(", ") || "none"}

Deterministic prefilter found these gaps:
${JSON.stringify(deterministic, null, 2)}

Report any additional gaps the prefilter missed, plus all expiring credentials.`,
      },
    ],
    tools: [
      {
        name: "report_missing",
        description: "Structured missing-docs report.",
        input_schema: TOOL_SCHEMA,
      },
    ],
    toolChoice: { type: "tool", name: "report_missing" },
    expectedSchema: ResultSchema,
    workspaceId: params.workspaceId,
    ...(params.caseId ? { relatedEntity: { type: "case", id: params.caseId } } : {}),
    maxTokens: 4096,
  });

  // Union: deterministic findings + model findings, dedupe by (kind, type).
  const merged = mergeMissing(deterministic, output.missing);
  return { missing: merged, expiring_soon: output.expiring_soon };
}

function prefilter(
  req: FacilityRequirements,
  evidence: CaseEvidence,
): MissingDocsResult["missing"] {
  const have = new Set(
    evidence.documents
      .filter((d) => d.confirmedAt && (!d.expiresAt || d.expiresAt.getTime() > Date.now()))
      .map((d) => d.documentType),
  );
  const verified = new Set(evidence.verifications.map((v) => v.type));

  const out: MissingDocsResult["missing"] = [];
  for (const r of req.required_documents) {
    if (!have.has(r.type)) {
      out.push({
        kind: "document",
        type: r.type,
        reason: `required document not on file (${describeRequirement(r)})`,
        severity: "blocker",
      });
    }
  }
  for (const v of req.required_verifications) {
    if (!verified.has(v.type) && VERIFICATION_TYPES.includes(v.type)) {
      out.push({
        kind: "verification",
        type: v.type,
        reason: "primary source verification has not been completed",
        severity: "blocker",
      });
    }
  }
  return out;
}

function describeRequirement(r: RequiredDocument): string {
  return r.attestation_required ? "with attestation" : "no attestation required";
}

function mergeMissing(
  a: MissingDocsResult["missing"],
  b: MissingDocsResult["missing"],
): MissingDocsResult["missing"] {
  const seen = new Set<string>();
  const out: MissingDocsResult["missing"] = [];
  for (const m of [...a, ...b]) {
    const key = `${m.kind}:${m.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

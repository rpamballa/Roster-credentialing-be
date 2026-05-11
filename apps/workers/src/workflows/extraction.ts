import type { DocumentType } from "@cred/types/domain";
import { ApplicationFailure, log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/extraction.js";

// PROMPT M2 §6.5 — upload → virus scan → classify → extract → persist.
// Activities are idempotent and retryable. Workflow runs on the worker, not
// in the API request path.
const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "2s",
    maximumInterval: "1 minute",
    backoffCoefficient: 2,
    maximumAttempts: 4,
  },
});

export interface ExtractionInput {
  documentId: string;
  workspaceId: string;
  actorUserId: string | null;
}

export async function extractionWorkflow(input: ExtractionInput): Promise<{
  status: "succeeded" | "needs_review";
  documentType: string;
}> {
  log.info("extraction.start", { documentId: input.documentId });

  try {
    await acts.virusScanActivity(input);
  } catch (err) {
    await acts.markFailedActivity({ ...input, reason: `virus_scan: ${stringify(err)}` });
    throw ApplicationFailure.nonRetryable("virus scan failed");
  }

  let classification: { documentType: DocumentType; confidence: number };
  try {
    const res = await acts.classifyActivity(input);
    classification = { documentType: res.documentType, confidence: res.confidence };
  } catch (err) {
    await acts.markFailedActivity({ ...input, reason: `classify: ${stringify(err)}` });
    throw ApplicationFailure.nonRetryable("classification failed");
  }

  let extraction: Awaited<ReturnType<typeof acts.extractActivity>>;
  try {
    extraction = await acts.extractActivity({
      ...input,
      documentType: classification.documentType,
    });
  } catch (err) {
    await acts.markFailedActivity({ ...input, reason: `extract: ${stringify(err)}` });
    throw ApplicationFailure.nonRetryable("extraction failed");
  }

  const persisted = await acts.persistExtractionActivity({
    ...input,
    documentType: classification.documentType,
    classifierConfidence: classification.confidence,
    fields: extraction.fields,
    averageConfidence: extraction.averageConfidence,
  });

  log.info("extraction.done", {
    documentId: input.documentId,
    status: persisted.status,
    documentType: classification.documentType,
  });

  return { status: persisted.status, documentType: classification.documentType };
}

function stringify(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

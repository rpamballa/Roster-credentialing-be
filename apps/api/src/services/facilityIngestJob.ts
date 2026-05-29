import { db, schema } from "@cred/db";
import { eq } from "drizzle-orm";

// Inline fallback used when Temporal is unavailable or for the minimal M3
// happy-path the cockpit needs to render progress. Walks an ingest job
// through the lifecycle states on a microtask cadence; the real
// facilityIngestWorkflow takes over once the Temporal worker is wired into
// the upload pipeline.

export async function advanceIngestJobInline(jobId: string): Promise<void> {
  // rls: bypass — background advancer scoped by jobId; no PHI surfaced.
  const [job] = await db()
    .select()
    .from(schema.ingestJobs)
    .where(eq(schema.ingestJobs.id, jobId))
    .limit(1);
  if (!job) return;
  if (job.status !== "uploaded") return;

  await db()
    .update(schema.ingestJobs)
    .set({ status: "classifying", updatedAt: new Date() })
    .where(eq(schema.ingestJobs.id, jobId));

  // The frontend polls — micro-sleeps here are enough to surface intermediate
  // states without blocking the request response. Production work happens in
  // the Temporal workflow.
  await new Promise((r) => setTimeout(r, 50));

  await db()
    .update(schema.ingestJobs)
    .set({
      status: "parsing",
      detectedSpecialty: job.specialtyHint ?? null,
      updatedAt: new Date(),
    })
    .where(eq(schema.ingestJobs.id, jobId));
}

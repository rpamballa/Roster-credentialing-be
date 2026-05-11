import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/verifications.js";

const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: "15 minutes",
  retry: { initialInterval: "10s", backoffCoefficient: 2, maximumAttempts: 3 },
});

export interface VerificationInput {
  workspaceId: string;
  providerId: string;
  state: string;
  licenseNumber: string;
}

export async function verificationWorkflow(input: VerificationInput): Promise<{ status: string }> {
  return acts.runStateLicenseVerification(input);
}

// Cron-triggered (Temporal Schedule) — runs nightly to flag expirations and
// re-verify stale PSV records.
export async function expirationSweepWorkflow(): Promise<{ flagged: number }> {
  return acts.expirationSweepActivity();
}

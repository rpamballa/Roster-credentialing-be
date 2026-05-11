import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/facilityIngest.js";

const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "5s",
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
});

export interface FacilityIngestInput {
  inboundEmailId: string;
  workspaceId: string;
}

export async function facilityIngestWorkflow(
  input: FacilityIngestInput,
): Promise<{ facilityProfileId: string }> {
  return acts.parseAndDraftActivity(input);
}

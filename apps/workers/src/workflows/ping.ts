import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/ping.js";

const { pingActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10s",
});

// M1: empty workflow per PROMPT M1 §6. M2 adds the extraction workflow.
export async function pingWorkflow(name = "world"): Promise<string> {
  log.info("ping workflow start", { name });
  const out = await pingActivity(name);
  log.info("ping workflow done", { out });
  return out;
}

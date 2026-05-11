import { fileURLToPath } from "node:url";
import { env } from "@cred/config";
import { logger, shutdownOtel, startOtel } from "@cred/observability";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as extractionActivities from "./activities/extraction.js";
import * as facilityIngestActivities from "./activities/facilityIngest.js";
import * as outreachActivities from "./activities/outreach.js";
import * as pingActivities from "./activities/ping.js";
import * as verificationActivities from "./activities/verifications.js";

async function main(): Promise<void> {
  startOtel("cred-workers");
  const cfg = env();

  const connection = await NativeConnection.connect({ address: cfg.TEMPORAL_ADDRESS });

  const worker = await Worker.create({
    connection,
    namespace: cfg.TEMPORAL_NAMESPACE,
    taskQueue: cfg.TEMPORAL_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./workflows/index.js", import.meta.url)),
    activities: {
      ...pingActivities,
      ...extractionActivities,
      ...facilityIngestActivities,
      ...outreachActivities,
      ...verificationActivities,
    },
  });

  logger.info(
    { taskQueue: cfg.TEMPORAL_TASK_QUEUE, namespace: cfg.TEMPORAL_NAMESPACE },
    "worker_starting",
  );

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "worker_shutdown");
    worker.shutdown();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await worker.run();
  await shutdownOtel();
}

main().catch((err) => {
  logger.error({ err }, "worker_fatal");
  process.exit(1);
});

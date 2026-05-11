import { env } from "@cred/config";
import { logger, shutdownOtel, startOtel } from "@cred/observability";
import { serve } from "@hono/node-server";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  startOtel("cred-api");
  const cfg = env();
  const app = buildApp();

  const server = serve({ fetch: app.fetch, port: cfg.API_PORT }, (info) => {
    logger.info({ port: info.port }, "api_listening");
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "api_shutdown");
    server.close();
    await shutdownOtel();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "api_fatal");
  process.exit(1);
});

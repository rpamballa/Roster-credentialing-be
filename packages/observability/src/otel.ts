import { env } from "@cred/config";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { NodeSDK, type NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { logger } from "./logger.js";

let sdk: NodeSDK | undefined;

export function startOtel(serviceName: string, serviceVersion = "0.0.0"): void {
  const cfg = env();
  if (sdk) return;

  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const sdkConfig: Partial<NodeSDKConfiguration> = {
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
      "deployment.environment": cfg.NODE_ENV,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  };

  if (otlpEndpoint) {
    sdkConfig.traceExporter = new OTLPTraceExporter();
  }

  sdk = new NodeSDK(sdkConfig);
  sdk.start();
  logger.info({ serviceName, otlpEndpoint: otlpEndpoint ?? "console" }, "otel_started");
}

export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
}

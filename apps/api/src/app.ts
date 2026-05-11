import { Hono } from "hono";
import { onError } from "./middleware/errors.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { requestContext } from "./middleware/requestContext.js";
import { sessionLoader } from "./middleware/session.js";
import { requireTenancy } from "./middleware/tenancy.js";
import { attestationRoutes } from "./routes/attestations.js";
import { authRoutes } from "./routes/auth.js";
import { graphqlHandler } from "./routes/graphql.js";
import { healthRoutes } from "./routes/health.js";
import { meRoutes } from "./routes/me.js";
import { metricsRoutes } from "./routes/metrics.js";
import { packetRoutes } from "./routes/packet.js";
import { providerRoutes } from "./routes/provider.js";
import { referenceRoutes } from "./routes/reference.js";
import { webhookRoutes } from "./routes/webhooks.js";
import type { ApiBindings } from "./types.js";

export function buildApp(): Hono<ApiBindings> {
  const app = new Hono<ApiBindings>();

  app.use("*", requestContext);
  app.use("*", sessionLoader);
  app.onError(onError);

  app.route("/", healthRoutes);

  // Anonymous, abuse-prone endpoints are rate-limited per IP.
  app.use("/auth/magic-link/*", rateLimit({ scope: "magic-link", windowSeconds: 60, max: 10 }));
  app.use("/reference/*", rateLimit({ scope: "reference", windowSeconds: 60, max: 30 }));
  app.use("/webhooks/*", rateLimit({ scope: "webhooks", windowSeconds: 60, max: 120 }));

  app.route("/", authRoutes);
  app.route("/", meRoutes);
  app.route("/", providerRoutes);
  app.route("/", referenceRoutes);
  app.route("/", webhookRoutes);
  app.route("/", attestationRoutes);
  app.route("/", packetRoutes);
  app.route("/", metricsRoutes);

  // Cockpit GraphQL requires a staff session + workspace tenancy.
  app.use("/graphql", requireTenancy);
  app.on(["GET", "POST"], "/graphql", graphqlHandler);

  app.notFound((c) =>
    c.json(
      {
        type: "about:blank",
        title: "Not Found",
        status: 404,
        instance: c.var.requestId,
      },
      404,
    ),
  );

  return app;
}

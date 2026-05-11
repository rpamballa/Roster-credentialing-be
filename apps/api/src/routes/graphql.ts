import { createYoga } from "graphql-yoga";
import type { Context } from "hono";
import type { GqlContext } from "../graphql/context.js";
import { cockpitSchema } from "../graphql/schema.js";
import type { ApiBindings } from "../types.js";

// Yoga is generic over the *server context* which becomes the resolver
// context when no `context` function is provided. We pass the fully-built
// GqlContext as the second arg to yoga.fetch on each request — that becomes
// the server context for that call.
const yoga = createYoga<GqlContext>({
  schema: cockpitSchema,
  graphqlEndpoint: "/graphql",
  landingPage: false,
  cors: false,
});

export async function graphqlHandler(c: Context<ApiBindings>): Promise<Response> {
  const serverContext: GqlContext = {
    tenancy: c.var.tenancy,
    requestId: c.var.requestId,
    honoCtx: c,
  };
  const res = await yoga.fetch(c.req.raw, serverContext);
  return res as unknown as Response;
}

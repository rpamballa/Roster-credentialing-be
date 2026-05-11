import { ReferenceTokenInvalidError, consumeReferenceToken } from "@cred/auth";
import { db, schema, withTenancy } from "@cred/db";
import { audit } from "@cred/observability";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiBindings } from "../types.js";

export const referenceRoutes = new Hono<ApiBindings>();

const SubmitSchema = z.object({
  token: z.string().min(32).max(256),
  answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

referenceRoutes.post("/reference/submit", zValidator("json", SubmitSchema), async (c) => {
  const { token, answers } = c.req.valid("json");
  try {
    const { referenceId, workspaceId } = await consumeReferenceToken(token);

    await withTenancy({ workspaceId, userId: null }, async (tx) => {
      await tx
        .update(schema.references)
        .set({
          status: "completed",
          responseFields: answers,
          respondedAt: new Date(),
        })
        .where(eq(schema.references.id, referenceId));
    });

    await audit({
      workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "reference.responded",
      targetEntityType: "reference",
      targetEntityId: referenceId,
      after: { fieldCount: Object.keys(answers).length },
      requestId: c.var.requestId,
    });

    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof ReferenceTokenInvalidError) {
      return c.json(
        {
          type: "https://errors.cred/reference/invalid-token",
          title: "Invalid or expired reference token",
          status: 400,
          instance: c.var.requestId,
        },
        400,
      );
    }
    throw err;
  }
});

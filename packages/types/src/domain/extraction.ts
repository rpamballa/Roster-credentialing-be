import { z } from "zod";

export const BboxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .describe("x, y, width, height (normalized 0-1)");

export const ExtractedFieldSchema = z.object({
  name: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  confidence: z.number().min(0).max(1),
  page: z.number().int().nonnegative(),
  bbox: BboxSchema,
});

export type ExtractedField = z.infer<typeof ExtractedFieldSchema>;

export const ExtractedFieldsSchema = z.array(ExtractedFieldSchema);

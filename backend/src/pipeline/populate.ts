import { z } from "zod";

/**
 * Upper bound accepted for `maxRowCount` on a populate request.
 *
 * This used to be a local `FREE_TIER_MONTHLY_QUOTA = 2500`, duplicating a
 * constant that Convex had already raised to 1e9 (see
 * frontend/convex/lib/quota.ts — ChampSet is an internal tool with no credit
 * gating). The stale copy meant Convex would happily accept a 50,000-row
 * dataset while `POST /populate` rejected it with a 400, for no real reason.
 *
 * Kept as an explicit request-level sanity cap rather than importing 1e9:
 * a single populate run asking for a billion rows is a bug, not an intent.
 */
const MAX_ROWS_PER_RUN = 50_000;
/** Rows requested when the caller doesn't say. Was 100. */
const DEFAULT_ROWS_PER_RUN = 1_000;

export const populateColumnSchema = z.object({
  name: z.string(),
  type: z.enum(["text", "number", "boolean", "url", "date"]),
  description: z.optional(z.string()),
  isPrimaryKey: z.optional(z.boolean()),
});
export type PopulateColumn = z.infer<typeof populateColumnSchema>;

export const datasetContextSchema = z.object({
  datasetId: z.string().min(1),
  datasetName: z.string(),
  description: z.string(),
  maxRowCount: z
    .number()
    .int()
    .min(1)
    .max(MAX_ROWS_PER_RUN)
    .default(DEFAULT_ROWS_PER_RUN),
  columns: z.array(populateColumnSchema).min(1),
  rowIds: z.array(z.string()).min(1).optional(),
});
export type DatasetContext = z.infer<typeof datasetContextSchema>;

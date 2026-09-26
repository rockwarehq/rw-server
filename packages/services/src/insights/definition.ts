import { z } from "zod";
import { RELATIVE_PRESETS } from "../reporting/dates.js";

// A report definition: what the report explorer saves, what data components
// on a board hold, and what the page runs with report.query. rw-ui
// apps/rw-imm/src/reports/explorer/definition.ts must stay the same shape.

export const FILTER_OPS = [
  "eq",
  "neq",
  "in",
  "notIn",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "notBetween",
  "contains",
  "beginsWith",
  "isNull",
  "notNull",
  "hasLabel",
  "notHasLabel",
] as const;

export const CHART_TYPES = ["bar", "stacked-bar", "line", "area", "pie", "table"] as const;

export const reportFilterSchema = z.object({
  dimension: z
    .string()
    .min(1)
    .max(64)
    .describe("A dimension, a `<dimension>Name` for matching on a name, or a measure"),
  op: z.enum(FILTER_OPS),
  value: z
    .union([z.string().max(256), z.array(z.string().max(256)).max(200)])
    .optional()
    .describe("One value; a list for in/notIn; two for between; none for isNull/notNull"),
});

export const dateRangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("relative"), preset: z.enum(RELATIVE_PRESETS) }),
  z.object({
    kind: z.literal("absolute"),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
]);

/** A report definition, as the explorer saves it. */
export const reportDefinitionSchema = z.object({
  v: z.literal(1),
  fact: z.string().min(1).max(64),
  measures: z.array(z.string().max(64)).min(1).max(20),
  dimensions: z.array(z.string().max(64)).max(10),
  filters: z.array(reportFilterSchema).max(20),
  segments: z.array(z.string().max(64)).max(10).optional(),
  dateRange: dateRangeSchema,
  granularity: z.enum(["hour", "day", "week", "month", "year"]).optional(),
  orderBy: z.object({ field: z.string().max(64), dir: z.enum(["asc", "desc"]) }).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
  display: z.object({ chartType: z.enum(CHART_TYPES) }).optional(),
});
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;

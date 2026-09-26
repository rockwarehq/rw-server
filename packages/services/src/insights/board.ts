import { z } from "zod";
import { RELATIVE_PRESETS } from "../reporting/dates.js";

// The shape of an Insights board: a question turned into tiles. This is the
// shape the AI builds and the shape IMM draws. It matches the saved-view
// "board" page in apps/api/src/rpc/saved-view.ts, and rw-ui
// apps/rw-imm/src/insights/board.ts must stay the same as this file.
//
// A report tile holds a report definition: the same thing the report
// explorer saves. So any tile can open in the explorer and be changed by hand.

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

const tileBase = {
  id: z.string().min(1).max(64),
  width: z.enum(["full", "half"]).optional(),
};

export const boardTileSchema = z.discriminatedUnion("kind", [
  z.object({ ...tileBase, kind: z.literal("report"), title: z.string().max(200), definition: reportDefinitionSchema }),
  z.object({ ...tileBase, kind: z.literal("figures"), title: z.string().max(200), definition: reportDefinitionSchema }),
  z.object({
    ...tileBase,
    kind: z.literal("text"),
    tone: z.enum(["summary", "note", "caveat"]),
    text: z.string().max(4000),
  }),
]);
export type BoardTile = z.infer<typeof boardTileSchema>;

export const MAX_TILES = 12;

export const boardSchema = z.object({
  v: z.literal(1),
  question: z.string().max(2000).optional(),
  tiles: z.array(boardTileSchema).max(MAX_TILES),
});
export type Board = z.infer<typeof boardSchema>;

export const emptyBoard = (): Board => ({ v: 1, tiles: [] });

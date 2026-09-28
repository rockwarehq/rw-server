import { z } from "zod";
import { compileReportQuery } from "../reporting/compiler.js";
import { resolveDateRange } from "../reporting/dates.js";
import type { ReportFilter, ReportQuery, ReportScope } from "../reporting/types.js";
import { VIEWS } from "../reporting/views.js";
import { type CHART_TYPES, dateRangeSchema, type ReportDefinition, reportFilterSchema } from "./definition.js";

// Queries the AI writes: always on a view, never a raw fact. The server turns
// them into report definitions (what tiles store and the page runs) and checks
// them with the report compiler before anything reaches the screen.

/** The caller's side of every tool: who is asking, where, and when. */
export interface QueryContext {
  scope: ReportScope;
  timezone: string;
  nowMs: number;
}

/** What the AI sends to run or place a query. */
export const viewQuerySchema = z.object({
  view: z.string().describe("A view key from the catalog, like oee or downtime"),
  measures: z.array(z.string()).min(1).max(8),
  dimensions: z.array(z.string()).max(4).default([]),
  filters: z.array(reportFilterSchema).max(10).default([]),
  segments: z.array(z.string()).max(4).optional(),
  dateRange: dateRangeSchema.describe(
    "Always set this. Use a relative preset when the person says things like 'last week'.",
  ),
  granularity: z
    .enum(["hour", "day", "week", "month", "year"])
    .optional()
    .describe("Bucket size when grouping by businessDate"),
  orderBy: z.object({ field: z.string(), dir: z.enum(["asc", "desc"]) }).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

/** Input shape: defaults may not be filled in yet. */
export type ViewQuery = z.input<typeof viewQuerySchema>;

export type Problem = { error: string };

/** Check a view query against its view, and turn it into a report definition. */
export function toDefinition(q: ViewQuery, chartType?: (typeof CHART_TYPES)[number]): ReportDefinition | Problem {
  const view = VIEWS[q.view];
  if (!view) return { error: `No view called ${q.view}. Use search_catalog to find one.` };
  const allowed = (list: readonly string[], keys: string[], what: string) => {
    const bad = keys.filter((k) => !list.includes(k));
    return bad.length > 0 ? `View ${q.view} has no ${what}: ${bad.join(", ")}. It has: ${list.join(", ")}.` : undefined;
  };
  const problem =
    allowed(view.measures, q.measures, "measure") ??
    allowed(view.dimensions, q.dimensions ?? [], "dimension") ??
    allowed(view.segments ?? [], q.segments ?? [], "segment");
  if (problem) return { error: problem };
  return {
    v: 1,
    fact: view.fact,
    measures: q.measures,
    dimensions: q.dimensions ?? [],
    filters: q.filters ?? [],
    ...(q.segments?.length ? { segments: q.segments } : {}),
    dateRange: q.dateRange,
    ...(q.granularity ? { granularity: q.granularity } : {}),
    ...(q.orderBy ? { orderBy: q.orderBy } : {}),
    ...(q.limit ? { limit: q.limit } : {}),
    ...(chartType ? { display: { chartType } } : {}),
  };
}

/** A report definition as a catalog query, with the dates worked out. */
export function toReportQuery(def: ReportDefinition, ctx: QueryContext): ReportQuery {
  return {
    fact: def.fact,
    measures: def.measures,
    dimensions: def.dimensions,
    filters: def.filters as ReportFilter[],
    segments: def.segments,
    ...resolveDateRange(def.dateRange, ctx.timezone, ctx.nowMs),
    dateGranularity: def.granularity,
    orderBy: def.orderBy,
    limit: def.limit,
  };
}

/** Ask the compiler whether a definition is valid, without running it. */
export function checkDefinition(def: ReportDefinition, ctx: QueryContext): Problem | undefined {
  const compiled = compileReportQuery(toReportQuery(def, ctx), ctx.scope);
  return "error" in compiled ? { error: compiled.error } : undefined;
}

/** toDefinition + checkDefinition in one step. */
export function buildDefinition(
  q: ViewQuery,
  ctx: QueryContext,
  chartType?: (typeof CHART_TYPES)[number],
): ReportDefinition | Problem {
  const def = toDefinition(q, chartType);
  if ("error" in def) return def;
  return checkDefinition(def, ctx) ?? def;
}

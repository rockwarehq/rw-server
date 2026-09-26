import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import { compileReportQuery, runReportQuery } from "../reporting/compiler.js";
import { resolveDateRange } from "../reporting/dates.js";
import { FACTS } from "../reporting/facts.js";
import { describeView, searchCatalog } from "../reporting/index.js";
import type { ReportFilter, ReportQuery, ReportScope } from "../reporting/types.js";
import { VIEWS } from "../reporting/views.js";
import {
  type Board,
  type BoardTile,
  CHART_TYPES,
  dateRangeSchema,
  MAX_TILES,
  type ReportDefinition,
  reportFilterSchema,
} from "./board.js";

// The tools the AI uses to answer a question. Every tool is built per request
// around the caller's own scope (site + workcenter grants), so the AI can
// never see or ask for more than the person asking could. The model only
// picks keys; all SQL still comes from the catalog.

/** The stream event carrying the new board to the page. */
export const BOARD_EVENT = "insights.board";

/** The stream event carrying one tile to show inside the answer. */
export const INLINE_EVENT = "insights.inline";

/** How many rows the AI gets to read from one query. The page shows the rest. */
const PREVIEW_ROWS = 50;

export interface InsightsToolContext {
  scope: ReportScope;
  timezone: string;
  nowMs: number;
  /** The board as it stands. update_board changes it in place. */
  board: Board;
  /** Called with the new board every time the AI changes it (tests use this). */
  onBoard?: (board: Board) => void;
}

/** What the AI sends to run or place a query: a view, not a raw fact. */
const viewQuerySchema = z.object({
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
type ViewQuery = z.input<typeof viewQuerySchema>;

type Problem = { error: string };

/** Check a view query against its view, and turn it into a report definition. */
function toDefinition(q: ViewQuery, chartType?: (typeof CHART_TYPES)[number]): ReportDefinition | Problem {
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
function toReportQuery(def: ReportDefinition, ctx: InsightsToolContext): ReportQuery {
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
function checkDefinition(def: ReportDefinition, ctx: InsightsToolContext): Problem | undefined {
  const compiled = compileReportQuery(toReportQuery(def, ctx), ctx.scope);
  return "error" in compiled ? { error: compiled.error } : undefined;
}

let tileSeed = 0;
const newTileId = () => `t${Date.now().toString(36)}${(tileSeed++).toString(36)}`;

export function insightsTools(ctx: InsightsToolContext) {
  const searchCatalogTool = toolDefinition({
    name: "search_catalog",
    description:
      "Find views, measures, dimensions and segments that match some words, like 'downtime reasons' or 'resin'. Use it when the view list in the instructions doesn't make the choice obvious.",
    inputSchema: z.object({ text: z.string().min(1).max(200) }),
  }).server(async ({ text }) => ({ hits: searchCatalog(text) }));

  const describeViewTool = toolDefinition({
    name: "describe_view",
    description:
      "Get everything about one view: its measures, dimensions, segments, and tips. Call this before your first query on a view.",
    inputSchema: z.object({ view: z.string() }),
  }).server(async ({ view }) => describeView(view) ?? { error: `No view called ${view}.` });

  const findValuesTool = toolDefinition({
    name: "find_values",
    description:
      "Look up the ids and names for a dimension, like which station is 'press 12'. Use the id in eq/in filters. Leave text empty to list the most active values.",
    inputSchema: z.object({
      view: z.string(),
      dimension: z.string(),
      text: z.string().max(100).optional(),
    }),
  }).server(async ({ view: viewKey, dimension, text }) => {
    const view = VIEWS[viewKey];
    const fact = view && FACTS[view.fact];
    const dim = fact?.dimensions[dimension];
    if (!view || !fact || !dim) return { error: `No dimension ${dimension} on view ${viewKey}.` };
    if (dim.type === "enum") return { values: (dim.enumValues ?? []).map((v) => ({ id: v, name: v })) };
    const hasName = dim.lookup !== undefined || dim.nameColumn !== undefined;
    // Any measure will do to list values, but not one that needs another dimension.
    const measure = view.measures.find((m) => !fact.measures[m]?.requiresDimensions?.length);
    if (!measure) return { error: `View ${viewKey} has no measures.` };
    const result = await runReportQuery(
      {
        fact: view.fact,
        measures: [measure],
        dimensions: [dimension],
        filters: text ? [{ dimension: hasName ? `${dimension}Name` : dimension, op: "contains", value: text }] : [],
        ...resolveDateRange({ kind: "relative", preset: "last-90-days" }, ctx.timezone, ctx.nowMs),
        orderBy: { field: measure, dir: "desc" },
        limit: 20,
      },
      ctx.scope,
    );
    if ("error" in result) return { error: result.error };
    return {
      note: "Values seen in the last 90 days, busiest first.",
      values: result.rows.map((r) => ({ id: r[dimension], name: hasName ? r[`${dimension}Name`] : r[dimension] })),
    };
  });

  const runQueryTool = toolDefinition({
    name: "run_query",
    description:
      "Run a query on a view and read the answer. Returns up to 50 rows. Use it to check your numbers before you put them on the board or in words.",
    inputSchema: viewQuerySchema,
  }).server(async (q) => {
    const def = toDefinition(q);
    if ("error" in def) return def;
    const query = toReportQuery(def, ctx);
    const result = await runReportQuery({ ...query, includeTotal: true }, ctx.scope);
    if ("error" in result) return { error: result.error };
    return {
      dates: { from: query.dateFrom ?? "any", to: query.dateTo ?? "any" },
      rowCount: result.total ?? result.rows.length,
      rows: result.rows.slice(0, PREVIEW_ROWS),
      ...(result.rows.length > PREVIEW_ROWS || result.truncated ? { note: "More rows exist than shown." } : {}),
    };
  });

  const tileInputSchema = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("report"),
      title: z.string().max(120),
      query: viewQuerySchema,
      chartType: z.enum(CHART_TYPES).optional().describe("bar for categories, line for time, table for many columns"),
      width: z.enum(["full", "half"]).optional(),
    }),
    z.object({
      kind: z.literal("figures"),
      title: z.string().max(120),
      query: viewQuerySchema.describe("Usually no dimensions: one row of totals shown as big numbers"),
      width: z.enum(["full", "half"]).optional(),
    }),
    z.object({
      kind: z.literal("text"),
      tone: z.enum(["summary", "note", "caveat"]),
      text: z.string().max(1500),
      width: z.enum(["full", "half"]).optional(),
    }),
  ]);

  type TileInput = z.input<typeof tileInputSchema>;

  /** A tile from what the AI sent, checked against the catalog and the compiler. */
  const buildTile = (id: string, tile: TileInput): BoardTile | Problem => {
    if (tile.kind === "text") {
      return { id, kind: "text", tone: tile.tone, text: tile.text, ...(tile.width ? { width: tile.width } : {}) };
    }
    const def = toDefinition(tile.query, tile.kind === "report" ? tile.chartType : undefined);
    if ("error" in def) return def;
    const problem = checkDefinition(def, ctx);
    if (problem) return problem;
    return { id, kind: tile.kind, title: tile.title, definition: def, ...(tile.width ? { width: tile.width } : {}) };
  };

  const showTool = toolDefinition({
    name: "show",
    description:
      "Show one chart, table or row of figures right inside your answer. Use it for small answers: one number, one comparison, one trend. It does not touch the board. The tile fetches its own numbers.",
    inputSchema: z.object({
      tile: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("report"),
          title: z.string().max(120),
          query: viewQuerySchema,
          chartType: z.enum(CHART_TYPES).optional(),
        }),
        z.object({ kind: z.literal("figures"), title: z.string().max(120), query: viewQuerySchema }),
      ]),
    }),
  }).server(async ({ tile }, toolContext) => {
    const built = buildTile(newTileId(), tile);
    if ("error" in built) return { error: built.error, hint: "Fix the query and call show again." };
    toolContext?.emitCustomEvent(INLINE_EVENT, { tile: built });
    return { shown: built.id };
  });

  const updateBoardTool = toolDefinition({
    name: "update_board",
    description:
      "Change the board the person sees. Add, replace or remove tiles, or clear the board to start fresh. Report and figures tiles fetch their own numbers, so never type numbers into them. Text tiles may only use numbers you read from run_query.",
    inputSchema: z.object({
      clear: z
        .boolean()
        .optional()
        .describe("Remove every tile first. Use it when the new question is about something else."),
      remove: z.array(z.string()).max(MAX_TILES).optional().describe("Tile ids to remove"),
      upsert: z
        .array(
          z.object({
            id: z.string().optional().describe("Give an existing id to replace that tile"),
            tile: tileInputSchema,
          }),
        )
        .max(MAX_TILES)
        .optional(),
      question: z.string().max(500).optional().describe("A short title for the board"),
    }),
  }).server(async ({ clear, remove, upsert, question }, toolContext) => {
    let tiles: BoardTile[] = clear ? [] : [...ctx.board.tiles];
    if (remove?.length) tiles = tiles.filter((t) => !remove.includes(t.id));
    const problems: string[] = [];
    for (const [i, { id, tile }] of (upsert ?? []).entries()) {
      const tileId = id ?? newTileId();
      const next = buildTile(tileId, tile);
      if ("error" in next) {
        problems.push(`upsert[${i}]${tile.kind === "text" ? "" : ` "${tile.title}"`}: ${next.error}`);
        continue;
      }
      const at = tiles.findIndex((t) => t.id === tileId);
      if (at >= 0) tiles[at] = next;
      else tiles.push(next);
    }
    if (tiles.length > MAX_TILES) {
      problems.push(`A board holds at most ${MAX_TILES} tiles; the last ones were dropped.`);
      tiles = tiles.slice(0, MAX_TILES);
    }
    ctx.board = { ...ctx.board, ...(question ? { question } : {}), tiles };
    // The page listens for this event and redraws the board.
    toolContext?.emitCustomEvent(BOARD_EVENT, { board: ctx.board });
    ctx.onBoard?.(ctx.board);
    return {
      tiles: tiles.map((t) => ({ id: t.id, kind: t.kind, title: t.kind === "text" ? t.text.slice(0, 60) : t.title })),
      ...(problems.length ? { problems, hint: "Fix these tiles and call update_board again." } : {}),
    };
  });

  return [searchCatalogTool, describeViewTool, findValuesTool, runQueryTool, showTool, updateBoardTool];
}

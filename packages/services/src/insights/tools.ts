import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import { runReportQuery } from "../reporting/compiler.js";
import { resolveDateRange } from "../reporting/dates.js";
import { FACTS } from "../reporting/facts.js";
import { describeView, searchCatalog } from "../reporting/index.js";
import { VIEWS } from "../reporting/views.js";
import { type Board, BOARD_ROOT, emptyBoard } from "./board.js";
import {
  buildElement,
  buildSpec,
  checkTree,
  type ElementInput,
  elementInputSchema,
  MAX_ELEMENTS,
  type SpecElement,
} from "./components.js";
import { type QueryContext, toDefinition, toReportQuery, viewQuerySchema } from "./query.js";

// The tools the AI uses to answer a question. Every tool is built per request
// around the caller's own scope (site + workcenter grants), so the AI can
// never see or ask for more than the person asking could. The model only
// picks keys and components; all SQL still comes from the catalog.

/** The stream event carrying the new board to the page. */
export const BOARD_EVENT = "insights.board";

/** The stream event carrying a small screen to show inside the answer. */
export const INLINE_EVENT = "insights.inline";

/** How many rows the AI gets to read from one query. The page shows the rest. */
const PREVIEW_ROWS = 50;

export interface InsightsToolContext extends QueryContext {
  /** The board as it stands. update_board changes it in place. */
  board: Board;
  /** Called with the new board every time the AI changes it (tests use this). */
  onBoard?: (board: Board) => void;
}

/** A short outline of a board for the AI: ids, types and titles, as a tree. */
function outline(board: Board): string[] {
  const lines: string[] = [];
  const walk = (id: string, depth: number) => {
    const el = board.spec.elements[id];
    if (!el) return;
    const p = el.props as { title?: string; text?: string; label?: string };
    const name = p.title ?? p.label ?? (p.text ? p.text.slice(0, 50) : "");
    lines.push(`${"  ".repeat(depth)}${id}: ${el.type}${name ? ` "${name}"` : ""}`);
    for (const child of el.children ?? []) walk(child, depth + 1);
  };
  walk(board.spec.root, 0);
  return lines;
}

let seed = 0;
const inlineRoot = () => `inline${Date.now().toString(36)}${(seed++).toString(36)}`;

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

  const specInput = {
    root: z.string().describe("Id of the top element"),
    elements: z.array(elementInputSchema).min(1).max(MAX_ELEMENTS),
  };

  const showTool = toolDefinition({
    name: "show",
    description:
      "Show a small screen right inside your answer: one to four elements, like a Figure, a Grid of Figures, or one Report. Use it for small answers. It does not touch the board. Data components fetch their own numbers.",
    inputSchema: z.object(specInput),
  }).server(async (input, toolContext) => {
    // Inline screens get fresh ids so two answers never collide.
    const prefix = inlineRoot();
    const rename = (id: string) => `${prefix}-${id}`;
    const renamed = {
      root: rename(input.root),
      elements: (input.elements as ElementInput[]).map((el) => ({
        ...el,
        id: rename(el.id),
        ...(el.children ? { children: el.children.map(rename) } : {}),
      })),
    };
    const { spec, problems } = buildSpec(renamed, ctx);
    if (problems.length > 0) return { problems, hint: "Fix these and call show again." };
    toolContext?.emitCustomEvent(INLINE_EVENT, { spec });
    return { shown: Object.keys(spec.elements).length };
  });

  const updateBoardTool = toolDefinition({
    name: "update_board",
    description: `Change the board that opens beside the chat. The board's top element is "${BOARD_ROOT}", a column. To add things, set new elements and set "${BOARD_ROOT}" again with its new children list. To change one thing (like making a chart weekly), set just that element again with the same id. Remove drops elements by id. Clear starts from an empty board.`,
    inputSchema: z.object({
      clear: z
        .boolean()
        .optional()
        .describe("Start from an empty board first. Use it when the new question is about something else."),
      set: z.array(elementInputSchema).max(MAX_ELEMENTS).optional().describe("Elements to add or replace, by id"),
      remove: z.array(z.string()).max(MAX_ELEMENTS).optional().describe("Element ids to remove"),
      title: z.string().max(200).optional().describe("A short title for the board"),
    }),
  }).server(async ({ clear, set, remove, title }, toolContext) => {
    const base = clear ? emptyBoard() : ctx.board;
    const elements: Record<string, SpecElement> = { ...base.spec.elements };
    const problems: string[] = [];
    const removed = new Set<string>();
    for (const id of remove ?? []) {
      if (id === BOARD_ROOT) problems.push(`The root "${BOARD_ROOT}" can't be removed; set its children instead.`);
      else {
        delete elements[id];
        removed.add(id);
      }
    }
    for (const input of (set ?? []) as ElementInput[]) {
      const built = buildElement(input, ctx);
      if ("error" in built) problems.push(`${input.id}: ${built.error}`);
      else elements[input.id] = built;
    }
    // Removed children quietly leave their parents' lists; any other missing
    // child is reported by checkTree.
    for (const [id, el] of Object.entries(elements)) {
      if (el.children?.some((child) => removed.has(child))) {
        elements[id] = { ...el, children: el.children.filter((child) => !removed.has(child)) };
      }
    }
    const tree = checkTree({ root: BOARD_ROOT, elements });
    problems.push(...tree.problems);
    ctx.board = { v: 2, ...(title ? { title } : base.title ? { title: base.title } : {}), spec: tree.spec };
    // The page listens for this event and redraws the board.
    toolContext?.emitCustomEvent(BOARD_EVENT, { board: ctx.board });
    ctx.onBoard?.(ctx.board);
    return {
      board: outline(ctx.board),
      ...(problems.length ? { problems, hint: "Fix these and call update_board again." } : {}),
    };
  });

  return [searchCatalogTool, describeViewTool, findValuesTool, runQueryTool, showTool, updateBoardTool];
}

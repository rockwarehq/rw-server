import { z } from "zod";
import { FACTS } from "../reporting/facts.js";
import { CHART_TYPES, type ReportDefinition, reportDefinitionSchema } from "./definition.js";
import { buildDefinition, type Problem, type QueryContext, viewQuerySchema } from "./query.js";

// The components the AI builds screens from, and how a screen is checked.
//
// A screen is a json-render spec: a flat list of elements by id, one of them
// the root, each with a type, props and (for layouts) children. The page draws
// it with json-render and a registry of Bedrock components. rw-ui
// apps/rw-imm/src/insights/catalog.ts must list the same types and stored
// props as this file.
//
// Each component has two prop shapes:
//   - what the AI sends: data components take a `query` on a view.
//   - what is stored and drawn: the query becomes a report `definition`.
// No component takes a number to show. Numbers only ever come from a data
// component's own query, run by the page with the viewer's access.

const STATUSES = ["run", "behind", "down", "setup", "planned", "off", "idle", "scrap"] as const;

interface ComponentDef {
  description: string;
  /** Whether the element may have children. */
  children: boolean;
  /** Props the AI sends. */
  input: z.ZodObject;
  /** Props that are stored and drawn. */
  stored: z.ZodObject;
  /** Turn checked AI props into stored props (data components run their query check here). */
  build?: (props: Record<string, unknown>, ctx: QueryContext) => Record<string, unknown> | Problem;
}

const text = (max = 2000) => z.string().min(1).max(max);

/** A data component: its `query` turns into a checked `definition`. */
function dataComponent(
  description: string,
  inputExtra: z.ZodRawShape,
  storedExtra: z.ZodRawShape,
  check?: (def: ReportDefinition, props: Record<string, unknown>) => string | undefined,
  chartOf?: (props: Record<string, unknown>) => (typeof CHART_TYPES)[number] | undefined,
): ComponentDef {
  return {
    description,
    children: false,
    input: z.object({ query: viewQuerySchema, ...inputExtra }),
    stored: z.object({ definition: reportDefinitionSchema, ...storedExtra }),
    build: (props, ctx) => {
      const { query, ...rest } = props as { query: z.input<typeof viewQuerySchema> };
      const def = buildDefinition(query, ctx, chartOf?.(props));
      if ("error" in def) return def;
      const problem = check?.(def, props);
      if (problem) return { error: problem };
      return { ...rest, definition: def };
    },
  };
}

export const COMPONENTS = {
  // ── Layout ──
  Stack: {
    description: "Puts children one after another, down the page or across it.",
    children: true,
    input: z.object({
      direction: z.enum(["column", "row"]).default("column"),
      gap: z.enum(["sm", "md", "lg"]).default("md"),
    }),
    stored: z.object({ direction: z.enum(["column", "row"]), gap: z.enum(["sm", "md", "lg"]) }),
  },
  Grid: {
    description: "Lays children out in equal columns. Good for a row of Figures, or two Reports side by side.",
    children: true,
    input: z.object({ columns: z.number().int().min(1).max(4) }),
    stored: z.object({ columns: z.number().int().min(1).max(4) }),
  },
  Card: {
    description: "A bordered panel around its children, with an optional title.",
    children: true,
    input: z.object({ title: text(120).optional() }),
    stored: z.object({ title: text(120).optional() }),
  },
  Section: {
    description: "A titled part of a board, with an optional line under the title. Its children follow.",
    children: true,
    input: z.object({ title: text(120), description: text(300).optional() }),
    stored: z.object({ title: text(120), description: text(300).optional() }),
  },
  Tabs: {
    description:
      "Tabs; each child is one tab's content, in the same order as labels. Use only for several views of the same thing.",
    children: true,
    input: z.object({ labels: z.array(text(40)).min(2).max(6) }),
    stored: z.object({ labels: z.array(text(40)).min(2).max(6) }),
  },
  Separator: {
    description: "A thin line between parts.",
    children: false,
    input: z.object({}),
    stored: z.object({}),
  },

  // ── Words ──
  Heading: {
    description: "A heading. Level 1 is biggest.",
    children: false,
    input: z.object({ text: text(160), level: z.number().int().min(1).max(3).default(2) }),
    stored: z.object({ text: text(160), level: z.number().int().min(1).max(3) }),
  },
  Text: {
    description:
      "Plain words. reading for the main answer, supporting for smaller notes, meta for tiny grey details. Numbers only if you read them from run_query.",
    children: false,
    input: z.object({ text: text(), variant: z.enum(["reading", "supporting", "meta"]).default("reading") }),
    stored: z.object({ text: text(), variant: z.enum(["reading", "supporting", "meta"]) }),
  },
  Callout: {
    description:
      "A short boxed message that stands out: info, caveat (watch out), good or bad news. Good for the one-line answer at the top.",
    children: false,
    input: z.object({ tone: z.enum(["info", "caveat", "good", "bad"]), title: text(120).optional(), text: text(600) }),
    stored: z.object({ tone: z.enum(["info", "caveat", "good", "bad"]), title: text(120).optional(), text: text(600) }),
  },
  Status: {
    description: "A small colored status word, like 'down' or 'running', with a label.",
    children: false,
    input: z.object({ status: z.enum(STATUSES), label: text(60) }),
    stored: z.object({ status: z.enum(STATUSES), label: text(60) }),
  },

  // ── Data (fetch their own numbers) ──
  Report: dataComponent(
    "A chart or table from a query. bar to compare things, line or area for change over time, table for many columns, pie only for a few parts of a whole.",
    { title: text(120).optional(), chart: z.enum(CHART_TYPES).default("bar") },
    { title: text(120).optional(), chart: z.enum(CHART_TYPES) },
    undefined,
    (props) => props.chart as (typeof CHART_TYPES)[number] | undefined,
  ),
  Figure: dataComponent(
    "One big number: a single measure from a query with no dimensions. Put several in a Grid for headline numbers.",
    { measure: z.string(), label: text(60).optional(), size: z.enum(["tile", "card", "sheet"]).default("tile") },
    { measure: z.string(), label: text(60).optional(), size: z.enum(["tile", "card", "sheet"]) },
    (def, props) => {
      if (def.dimensions.length > 0) return "Figure needs a query with no dimensions.";
      if (!def.measures.includes(props.measure as string))
        return `Figure measure ${props.measure} must be in the query's measures.`;
      return undefined;
    },
  ),
  Figures: dataComponent(
    "A row of big numbers, one per measure, from a query with no dimensions.",
    { title: text(120).optional() },
    { title: text(120).optional() },
    (def) => (def.dimensions.length > 0 ? "Figures needs a query with no dimensions." : undefined),
  ),
  StatusStrip: dataComponent(
    "A colored bar split by a status, like time up versus down. The query groups by one status dimension (state or status) and one measure sets each part's width.",
    { dimension: z.string(), measure: z.string(), title: text(120).optional() },
    { dimension: z.string(), measure: z.string(), title: text(120).optional() },
    (def, props) => {
      if (def.dimensions.length !== 1 || def.dimensions[0] !== props.dimension) {
        return `StatusStrip query must group by exactly ${props.dimension}.`;
      }
      const dim = FACTS[def.fact]?.dimensions[props.dimension as string];
      if (dim?.type !== "enum") return "StatusStrip needs a status-like dimension (state or status).";
      if (!def.measures.includes(props.measure as string))
        return `StatusStrip measure ${props.measure} must be in the query's measures.`;
      return undefined;
    },
  ),
} satisfies Record<string, ComponentDef>;

export type ComponentType = keyof typeof COMPONENTS;
export const COMPONENT_TYPES = Object.keys(COMPONENTS) as [ComponentType, ...ComponentType[]];

// ── Specs ─────────────────────────────────────────────────────────────────────

/** A stored element: json-render's element shape. */
export interface SpecElement {
  type: ComponentType;
  props: Record<string, unknown>;
  children?: string[];
}

/** A json-render spec: the root id and every element by id. */
export interface Spec {
  root: string;
  elements: Record<string, SpecElement>;
}

export const MAX_ELEMENTS = 60;
const MAX_INLINE_ELEMENTS = 8;

// The AI picks short ids. Stored ids have room for the prefixes the server
// and page add when a screen is copied between an answer and the board.
const idSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z0-9_-]+$/, "Use letters, numbers, - and _ only");
const storedIdSchema = z.string().min(1).max(96);

/** One element as the AI sends it. */
export interface ElementInput {
  id: string;
  type: ComponentType;
  props: Record<string, unknown>;
  children?: string[];
}

/** One element as the AI sends it: typed props per component (checked again in buildElement). */
export const elementInputSchema = z.discriminatedUnion(
  "type",
  COMPONENT_TYPES.map((type) => {
    const def = COMPONENTS[type];
    return z.object({
      id: idSchema,
      type: z.literal(type),
      props: def.input,
      ...(def.children ? { children: z.array(idSchema).max(24).optional() } : {}),
    });
  }) as unknown as [z.ZodObject, ...z.ZodObject[]],
) as unknown as z.ZodType<ElementInput>;

/** A stored element, checked loosely: the page checks props again before drawing. */
export const storedSpecSchema = z.object({
  root: storedIdSchema,
  elements: z
    .record(
      storedIdSchema,
      z.object({
        type: z.enum(COMPONENT_TYPES),
        props: z.record(z.string(), z.unknown()),
        children: z.array(storedIdSchema).max(24).optional(),
      }),
    )
    .refine((els) => Object.keys(els).length <= MAX_ELEMENTS, `At most ${MAX_ELEMENTS} elements`),
});

/** Build one stored element from what the AI sent. */
export function buildElement(input: ElementInput, ctx: QueryContext): SpecElement | Problem {
  const def: ComponentDef = COMPONENTS[input.type as ComponentType];
  if (!def) return { error: `Unknown component ${input.type}.` };
  const parsed = def.input.safeParse(input.props ?? {});
  if (!parsed.success)
    return {
      error: `${input.type} props: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    };
  const props = def.build ? def.build(parsed.data, ctx) : parsed.data;
  if ("error" in props && typeof props.error === "string") return props as Problem;
  const children = input.children;
  return { type: input.type as ComponentType, props, ...(def.children ? { children: children ?? [] } : {}) };
}

/**
 * Check a spec's shape and return a safe copy: the root exists, children that
 * don't exist or would loop back are cut (and reported), and elements nothing
 * points at are dropped, so a half-edited board never keeps stray parts. The
 * copy is always safe to draw, even when there are problems.
 */
export function checkTree(spec: Spec, max = MAX_ELEMENTS): { spec: Spec; problems: string[] } {
  const problems: string[] = [];
  if (!spec.elements[spec.root])
    return { spec: { root: spec.root, elements: {} }, problems: [`Root ${spec.root} is not an element.`] };
  const kept: Record<string, SpecElement> = {};
  const walk = (id: string, path: string[]) => {
    if (kept[id]) return;
    const el = spec.elements[id]!;
    const children: string[] = [];
    kept[id] = { ...el, ...(el.children ? { children } : {}) };
    for (const child of el.children ?? []) {
      if (!spec.elements[child]) problems.push(`${id} lists a child ${child} that doesn't exist.`);
      else if ([...path, id].includes(child))
        problems.push(`${child} contains itself (${[...path, id, child].join(" → ")}).`);
      else {
        children.push(child);
        walk(child, [...path, id]);
      }
    }
  };
  walk(spec.root, []);
  if (Object.keys(kept).length > max)
    problems.push(`Too many elements (${Object.keys(kept).length}); keep it to ${max}.`);
  return { spec: { root: spec.root, elements: kept }, problems };
}

/** Build a whole spec from what the AI sent (used by `show`). */
export function buildSpec(
  input: { root: string; elements: ElementInput[] },
  ctx: QueryContext,
  max = MAX_INLINE_ELEMENTS,
): { spec: Spec; problems: string[] } {
  const problems: string[] = [];
  const elements: Record<string, SpecElement> = {};
  for (const el of input.elements) {
    if (elements[el.id]) problems.push(`Two elements are called ${el.id}.`);
    const built = buildElement(el, ctx);
    if ("error" in built) problems.push(`${el.id}: ${built.error}`);
    else elements[el.id] = built;
  }
  const tree = checkTree({ root: input.root, elements }, max);
  return { spec: tree.spec, problems: [...problems, ...tree.problems] };
}

/** The component list for the AI's instructions, straight from the catalog. */
export function componentGuide(): string {
  return COMPONENT_TYPES.map((type) => {
    const def: ComponentDef = COMPONENTS[type];
    return `- ${type}${def.children ? " (has children)" : ""}: ${def.description}`;
  }).join("\n");
}

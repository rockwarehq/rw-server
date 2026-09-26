import { z } from "zod";
import { userRequired } from "./middleware.js";
import { savedView } from "@rw/services/saved-view/index";
import { throwServiceError } from "./errors.js";

// Saved page views (Linear-style): generic verbs over one table, with a
// typed per-page config union (the historian selector-union pattern, ADR
// 0008 §1) — adding views to another page later is one union member, no new
// endpoints. Visibility: "PRIVATE" (creator only) or "WORKSPACE" (all
// workspace members). Publishing config to a WORKSPACE view is open to any
// member; rename/reshare/delete are creator-only (enforced in the service).

// ============================================================================
// Input Schemas
// ============================================================================

const shiftViewConfigSchema = z.object({
  // Filter dimension selections (null = no filter on that dimension). Views
  // save selections, not resolved stations, so they stay correct as station
  // attributes change.
  stationIds: z.array(z.uuid()).nullable(),
  labelIds: z.array(z.uuid()).nullable(),
  stationsLayout: z.enum(["list", "cards"]),
  chartMode: z.enum(["production", "oee"]),
  showChart: z.boolean(),
  showKpis: z.boolean(),
  wcKpiVisibility: z.record(z.string(), z.boolean()),
  stationPropertyVisibility: z.record(z.string(), z.boolean()),
});

// Station directory (stations page "list" tab): which live columns show, in
// display order. Column ids are a client-side catalog, so plain strings.
const stationsDirectoryConfigSchema = z.object({
  columns: z.array(z.string().min(1)).max(50),
});

// Workcenter timeline (status gantt): overlay-layer toggles + the same
// filter-selection semantics as shift-view (selections, not resolved
// stations).
const timelineConfigSchema = z.object({
  layers: z.object({
    jobs: z.boolean(),
    downtime: z.boolean(),
    shifts: z.boolean(),
    andon: z.boolean(),
  }),
  stationIds: z.array(z.uuid()).nullable(),
  labelIds: z.array(z.uuid()).nullable(),
});

// Station cycles page (scopeId = stationId): the viewer's implicit default —
// a time range plus the quiet display mode that mutes good cycles so
// exceptions pop. "day" (a fixed calendar date) is deliberately not a
// saveable range: a default view must describe a rolling window, not a
// moment.
const stationCyclesConfigSchema = z.object({
  range: z.enum(["5m", "1h", "today", "24h"]),
  quietGoodCycles: z.boolean(),
});

// A report filter: the same shape and bounds report.query accepts.
const reportFiltersSchema = z
  .array(
    z.object({
      dimension: z.string().max(64),
      op: z.enum([
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
      ]),
      value: z.union([z.string().max(256), z.array(z.string().max(256)).max(200)]).optional(),
    }),
  )
  .max(20);

// Report explorer definitions. The query-shaped core mirrors report.ts
// querySchema bounds so a stored config cannot smuggle an oversized payload,
// but fact/measure/dimension KEYS are deliberately not validated against the
// report catalog: catalog renames must not brick saved rows, and report.query
// re-validates keys at read time. `dateRange.preset` and `display` stay loose
// — which relative presets exist and how results render are client concerns
// that must not require a server deploy.
const reportDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

const reportDateRangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("relative"), preset: z.string().min(1).max(32) }),
  z.object({ kind: z.literal("absolute"), from: reportDateString, to: reportDateString }),
]);

const reportConfigSchema = z.object({
  v: z.literal(1),
  fact: z.string().min(1).max(64),
  measures: z.array(z.string().max(64)).min(1).max(20),
  dimensions: z.array(z.string().max(64)).max(10),
  filters: reportFiltersSchema,
  // Named filters from the catalog (report.schema segments).
  segments: z.array(z.string().max(64)).max(10).optional(),
  dateRange: reportDateRangeSchema,
  granularity: z.enum(["hour", "day", "week", "month", "year"]).optional(),
  orderBy: z.object({ field: z.string().max(64), dir: z.enum(["asc", "desc"]) }).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
  display: z.looseObject({}).optional(),
});

// Insights boards: a question turned into tiles. Each report tile holds a
// report definition (same shape as a saved "report"). Board filters apply to
// every tile whose fact has that dimension. Text tiles hold words the AI or a
// person wrote. Like reports, keys are checked when the board runs, not here.
const boardTileSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1).max(64),
    kind: z.literal("report"),
    title: z.string().max(200),
    definition: reportConfigSchema,
    width: z.enum(["full", "half"]).optional(),
  }),
  z.object({
    id: z.string().min(1).max(64),
    kind: z.literal("figures"),
    title: z.string().max(200),
    definition: reportConfigSchema,
    width: z.enum(["full", "half"]).optional(),
  }),
  z.object({
    id: z.string().min(1).max(64),
    kind: z.literal("text"),
    tone: z.enum(["summary", "note", "caveat"]),
    text: z.string().max(4000),
    width: z.enum(["full", "half"]).optional(),
  }),
]);

const boardV1ConfigSchema = z.object({
  v: z.literal(1),
  question: z.string().max(2000).optional(),
  dateRange: reportDateRangeSchema.optional(),
  filters: reportFiltersSchema.optional(),
  tiles: z.array(boardTileSchema).max(24),
});

// v2: a json-render spec of Insights components (rw-server
// packages/services/src/insights/components.ts). Shape and size are checked
// here; component props are checked when the board is drawn, like reports.
const specIdSchema = z.string().min(1).max(64);
const boardV2ConfigSchema = z.object({
  v: z.literal(2),
  title: z.string().max(200).optional(),
  spec: z.object({
    root: specIdSchema,
    elements: z
      .record(
        specIdSchema,
        z.object({
          type: z.string().min(1).max(32),
          props: z.record(z.string(), z.unknown()),
          children: z.array(specIdSchema).max(24).optional(),
        }),
      )
      .refine((elements) => Object.keys(elements).length <= 80, "At most 80 elements"),
  }),
});

const boardConfigSchema = z.discriminatedUnion("v", [boardV1ConfigSchema, boardV2ConfigSchema]);

// One member per page that supports saved views.
const pageConfigSchema = z.discriminatedUnion("page", [
  z.object({ page: z.literal("shift-view"), config: shiftViewConfigSchema }),
  z.object({ page: z.literal("stations-directory"), config: stationsDirectoryConfigSchema }),
  z.object({ page: z.literal("timeline"), config: timelineConfigSchema }),
  z.object({ page: z.literal("station-cycles"), config: stationCyclesConfigSchema }),
  z.object({ page: z.literal("report"), config: reportConfigSchema }),
  z.object({ page: z.literal("board"), config: boardConfigSchema }),
]);

const pageSchema = z.enum(["shift-view", "stations-directory", "timeline", "station-cycles", "report", "board"]);
const visibilitySchema = z.enum(["PRIVATE", "WORKSPACE"]);

export const createInputSchema = z
  .object({
    siteId: z.uuid(),
    scopeId: z.uuid().nullish(),
    name: z.string().min(1),
    description: z.string().nullish(),
    visibility: visibilitySchema,
  })
  .and(pageConfigSchema);

// Config updates re-validate against the page union (config optional — a
// rename-only update carries none).
const updateConfigSchema = z.discriminatedUnion("page", [
  z.object({ page: z.literal("shift-view"), config: shiftViewConfigSchema.optional() }),
  z.object({
    page: z.literal("stations-directory"),
    config: stationsDirectoryConfigSchema.optional(),
  }),
  z.object({ page: z.literal("timeline"), config: timelineConfigSchema.optional() }),
  z.object({ page: z.literal("station-cycles"), config: stationCyclesConfigSchema.optional() }),
  z.object({ page: z.literal("report"), config: reportConfigSchema.optional() }),
  z.object({ page: z.literal("board"), config: boardConfigSchema.optional() }),
]);

export const updateInputSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).optional(),
    description: z.string().nullish(),
    visibility: visibilitySchema.optional(),
  })
  .and(updateConfigSchema);

const listInputSchema = z.object({
  siteId: z.uuid(),
  page: pageSchema,
  scopeId: z.uuid().nullish(),
});

const idInputSchema = z.object({ id: z.uuid() });

// ============================================================================
// Procedures
// ============================================================================

export const create = userRequired.input(createInputSchema).handler(async ({ input, context }) => {
  const userId = context.current.user.id;
  await context.access.require("MANAGE", { site: input.siteId });

  const result = await savedView.create({
    siteId: input.siteId,
    page: input.page,
    scopeId: input.scopeId ?? null,
    name: input.name,
    description: input.description ?? null,
    visibility: input.visibility,
    config: input.config,
    createdById: userId,
  });
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const list = userRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const userId = context.current.user.id;
  await context.access.require("VIEW", { site: input.siteId });

  const result = await savedView.list({
    siteId: input.siteId,
    page: input.page,
    scopeId: input.scopeId ?? null,
    userId,
  });
  if (result.error !== undefined) throwServiceError(result);
  return { data: result.data };
});

export const update = userRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const userId = context.current.user.id;
  await context.access.require("MANAGE", { savedView: input.id });

  const result = await savedView.update(input.id, {
    actorId: userId,
    name: input.name,
    description: input.description === undefined ? undefined : (input.description ?? null),
    visibility: input.visibility,
    config: input.config,
  });
  if (result.error !== undefined) {
    throwServiceError({ error: result.error, code: result.code ?? "BAD_REQUEST" });
  }
  return result.data;
});

export const remove = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const userId = context.current.user.id;
  await context.access.require("MANAGE", { savedView: input.id });

  const result = await savedView.remove(input.id, { actorId: userId });
  if (result.error !== undefined) {
    throwServiceError({ error: result.error, code: result.code ?? "BAD_REQUEST" });
  }
  return { success: true };
});

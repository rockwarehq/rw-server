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

// One member per page that supports saved views.
const pageConfigSchema = z.discriminatedUnion("page", [
  z.object({ page: z.literal("shift-view"), config: shiftViewConfigSchema }),
  z.object({ page: z.literal("stations-directory"), config: stationsDirectoryConfigSchema }),
  z.object({ page: z.literal("timeline"), config: timelineConfigSchema }),
  z.object({ page: z.literal("station-cycles"), config: stationCyclesConfigSchema }),
]);

const pageSchema = z.enum(["shift-view", "stations-directory", "timeline", "station-cycles"]);
const visibilitySchema = z.enum(["PRIVATE", "WORKSPACE"]);

const createInputSchema = z
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
]);

const updateInputSchema = z
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
  const { workspaceId } = context.current;
  await context.access.require("MANAGE", { site: input.siteId });

  const result = await savedView.create(
    {
      siteId: input.siteId,
      page: input.page,
      scopeId: input.scopeId ?? null,
      name: input.name,
      description: input.description ?? null,
      visibility: input.visibility,
      config: input.config,
      createdById: userId,
    },
    workspaceId,
  );
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const list = userRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const userId = context.current.user.id;
  const { workspaceId } = context.current;
  await context.access.require("VIEW", { site: input.siteId });

  const result = await savedView.list(
    { siteId: input.siteId, page: input.page, scopeId: input.scopeId ?? null, userId },
    workspaceId,
  );
  if (result.error !== undefined) throwServiceError(result);
  return { data: result.data };
});

export const update = userRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const userId = context.current.user.id;
  const { workspaceId } = context.current;
  await context.access.require("MANAGE", { savedView: input.id });

  const result = await savedView.update(
    input.id,
    {
      actorId: userId,
      name: input.name,
      description: input.description === undefined ? undefined : (input.description ?? null),
      visibility: input.visibility,
      config: input.config,
    },
    workspaceId,
  );
  if (result.error !== undefined) {
    throwServiceError({ error: result.error, code: result.code ?? "BAD_REQUEST" });
  }
  return result.data;
});

export const remove = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const userId = context.current.user.id;
  const { workspaceId } = context.current;
  await context.access.require("MANAGE", { savedView: input.id });

  const result = await savedView.remove(input.id, { actorId: userId }, workspaceId);
  if (result.error !== undefined) {
    throwServiceError({ error: result.error, code: result.code ?? "BAD_REQUEST" });
  }
  return { success: true };
});

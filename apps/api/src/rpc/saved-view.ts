import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired } from "./middleware.js";
import { authorize } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";
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

// Report explorer definitions. The query-shaped core mirrors report.ts
// querySchema bounds so a stored config cannot smuggle an oversized payload,
// but fact/measure/dimension KEYS are deliberately not validated against the
// report catalog: catalog renames must not brick saved rows, and report.query
// re-validates keys at read time. `dateRange.preset` and `display` stay loose
// — which relative presets exist and how results render are client concerns
// that must not require a server deploy.
const reportDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

const reportConfigSchema = z.object({
  v: z.literal(1),
  fact: z.string().min(1).max(64),
  measures: z.array(z.string().max(64)).min(1).max(20),
  dimensions: z.array(z.string().max(64)).max(10),
  filters: z
    .array(
      z.object({
        dimension: z.string().max(64),
        op: z.enum(["eq", "neq", "in"]),
        value: z.union([z.string().max(256), z.array(z.string().max(256)).max(200)]),
      }),
    )
    .max(20),
  dateRange: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("all") }),
    z.object({ kind: z.literal("relative"), preset: z.string().min(1).max(32) }),
    z.object({ kind: z.literal("absolute"), from: reportDateString, to: reportDateString }),
  ]),
  granularity: z.enum(["hour", "day", "week", "month", "year"]).optional(),
  orderBy: z.object({ field: z.string().max(64), dir: z.enum(["asc", "desc"]) }).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
  display: z.looseObject({}).optional(),
});

// One member per page that supports saved views.
const pageConfigSchema = z.discriminatedUnion("page", [
  z.object({ page: z.literal("shift-view"), config: shiftViewConfigSchema }),
  z.object({ page: z.literal("stations-directory"), config: stationsDirectoryConfigSchema }),
  z.object({ page: z.literal("timeline"), config: timelineConfigSchema }),
  z.object({ page: z.literal("report"), config: reportConfigSchema }),
]);

const pageSchema = z.enum(["shift-view", "stations-directory", "timeline", "report"]);
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
  z.object({ page: z.literal("report"), config: reportConfigSchema.optional() }),
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

function requireUserContext(iam: { id?: string; workspaceId?: string }) {
  if (!iam.workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }
  if (!iam.id) {
    throw new ORPCError("BAD_REQUEST", { message: "User context required" });
  }
  return { userId: iam.id, workspaceId: iam.workspaceId };
}

export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  const { userId, workspaceId } = requireUserContext(context.iam);
  grant(await authorize(context.iam, { permission: "dashboard:write", scope: { kind: "site", siteId: input.siteId } }));

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

export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const { userId, workspaceId } = requireUserContext(context.iam);
  grant(await authorize(context.iam, { permission: "dashboard:read", scope: { kind: "site", siteId: input.siteId } }));

  const result = await savedView.list(
    { siteId: input.siteId, page: input.page, scopeId: input.scopeId ?? null, userId },
    workspaceId,
  );
  if (result.error !== undefined) throwServiceError(result);
  return { data: result.data };
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const { userId, workspaceId } = requireUserContext(context.iam);
  grant(await authorize(context.iam, { permission: "dashboard:write", scope: { kind: "savedView", id: input.id } }));

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

export const remove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const { userId, workspaceId } = requireUserContext(context.iam);
  grant(await authorize(context.iam, { permission: "dashboard:write", scope: { kind: "savedView", id: input.id } }));

  const result = await savedView.remove(input.id, { actorId: userId }, workspaceId);
  if (result.error !== undefined) {
    throwServiceError({ error: result.error, code: result.code ?? "BAD_REQUEST" });
  }
  return { success: true };
});

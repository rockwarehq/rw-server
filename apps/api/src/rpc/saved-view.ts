import { z } from "zod";
import { ORPCError } from "@orpc/server";
import prisma from "@rw/db";
import type { IAMContext } from "@rw/auth/context";
import { authRequired } from "./middleware.js";
import { authorizePhysicalTarget, authorizePhysicalList } from "../api/authz.js";
import { grant } from "./authz.js";
import { savedView } from "@rw/services/saved-view/index";
import { throwServiceError, unwrap } from "./errors.js";

// Saved page views (Linear-style): generic verbs over one table, with a
// typed per-page config union (the historian selector-union pattern, ADR
// 0008 §1) — adding views to another page later is one union member, no new
// endpoints. Visibility: "PRIVATE" (creator only) or "WORKSPACE" (all
// members with access to the view's context). Personal preferences need that
// same read access; shared publishing needs site configuration authority.
// Rename/reshare/delete remain creator-only (enforced in the service).

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

function requireUserContext(iam: { id?: string; workspaceId?: string }) {
  if (!iam.workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }
  if (!iam.id) {
    throw new ORPCError("BAD_REQUEST", { message: "User context required" });
  }
  return { userId: iam.id, workspaceId: iam.workspaceId };
}

interface ViewContext {
  siteId: string;
  page: string;
  scopeId?: string | null;
}

/** Authorize the actual page context, not the saved-view row's site alone. */
async function authorize(
  iam: IAMContext,
  view: ViewContext,
  options: { sharedWrite?: boolean; config?: Record<string, unknown> } = {},
) {
  if (!pageSchema.safeParse(view.page).success) {
    throw new ORPCError("BAD_REQUEST", { message: "Unsupported saved-view page" });
  }
  // Known physical anchors only. stations-directory has no defined scopeId
  // namespace; keep its optional opaque namespace rather than inventing a FK.
  // Null anchors remain site-context defaults, with the same narrowed read
  // access as the underlying production list.
  const kind =
    view.page === "station-cycles"
      ? "station"
      : view.page === "shift-view" || view.page === "timeline"
        ? "workcenter"
        : undefined;
  let workcenterIds: string[] | undefined;
  if (kind && view.scopeId) {
    const scope = grant(
      await authorizePhysicalTarget(iam, {
        permission: "production:read",
        scope: { kind, id: view.scopeId },
      }),
    );
    if (scope.siteId !== view.siteId) {
      throw new ORPCError("FORBIDDEN", { message: "View scope does not belong to this site" });
    }
    if (kind === "workcenter") workcenterIds = [view.scopeId];
  } else {
    const scope = grant(
      await authorizePhysicalList(iam, {
        permission: "production:read",
        requestedSiteId: view.siteId,
      }),
    );
    workcenterIds = scope.workcenterIds;
  }
  if (options.sharedWrite) {
    grant(
      await authorizePhysicalTarget(iam, {
        permission: "configuration:write",
        scope: { kind: "site", siteId: view.siteId },
      }),
    );
  }

  // Filter selections are references, not authority. Validate the submitted
  // configuration against the proven site/workcenter set before persisting it.
  const stationIds = options.config?.stationIds;
  if (Array.isArray(stationIds) && stationIds.length) {
    const ids = [...new Set(stationIds as string[])];
    const count = await prisma.station.count({
      where: {
        id: { in: ids },
        siteId: view.siteId,
        deletedAt: null,
        ...(workcenterIds ? { workcenterId: { in: workcenterIds } } : {}),
      },
    });
    if (count !== ids.length) {
      throw new ORPCError("FORBIDDEN", { message: "Station filters must belong to the accessible view context" });
    }
  }
  const labelIds = options.config?.labelIds;
  if (Array.isArray(labelIds) && labelIds.length) {
    const ids = [...new Set(labelIds as string[])];
    const count = await prisma.label.count({ where: { id: { in: ids }, siteId: view.siteId } });
    if (count !== ids.length) {
      throw new ORPCError("FORBIDDEN", { message: "Label filters must belong to the view's site" });
    }
  }
}

export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  const { userId, workspaceId } = requireUserContext(context.iam);
  await authorize(context.iam, input, { sharedWrite: input.visibility === "WORKSPACE", config: input.config });

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
  await authorize(context.iam, input);

  const result = await savedView.list(
    { siteId: input.siteId, page: input.page, scopeId: input.scopeId ?? null, userId },
    workspaceId,
  );
  if (result.error !== undefined) throwServiceError(result);
  return { data: result.data };
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const { userId, workspaceId } = requireUserContext(context.iam);
  const current = unwrap(await savedView.getContext(input.id, workspaceId));
  if (input.page !== current.page) {
    throw new ORPCError("BAD_REQUEST", { message: "Page does not match the saved view" });
  }
  await authorize(context.iam, current, {
    sharedWrite: current.visibility === "WORKSPACE" || input.visibility === "WORKSPACE",
    config: input.config,
  });

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
  const current = unwrap(await savedView.getContext(input.id, workspaceId));
  await authorize(context.iam, current, { sharedWrite: current.visibility === "WORKSPACE" });

  const result = await savedView.remove(input.id, { actorId: userId }, workspaceId);
  if (result.error !== undefined) {
    throwServiceError({ error: result.error, code: result.code ?? "BAD_REQUEST" });
  }
  return { success: true };
});

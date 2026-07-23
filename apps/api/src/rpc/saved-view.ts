import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired } from "./middleware.js";
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
  stationIds: z.array(z.uuid()).nullable(),
  stationsLayout: z.enum(["list", "cards"]),
  chartMode: z.enum(["production", "oee"]),
  showChart: z.boolean(),
  showKpis: z.boolean(),
  wcKpiVisibility: z.record(z.string(), z.boolean()),
  stationPropertyVisibility: z.record(z.string(), z.boolean()),
});

// One member per page that supports saved views.
const pageConfigSchema = z.discriminatedUnion("page", [
  z.object({ page: z.literal("shift-view"), config: shiftViewConfigSchema }),
]);

const pageSchema = z.enum(["shift-view"]);
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

const updateInputSchema = z.object({
  id: z.uuid(),
  // Config updates re-validate against the page union.
  page: pageSchema,
  name: z.string().min(1).optional(),
  description: z.string().nullish(),
  visibility: visibilitySchema.optional(),
  config: shiftViewConfigSchema.optional(),
});

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

  const result = await savedView.list(
    { siteId: input.siteId, page: input.page, scopeId: input.scopeId ?? null, userId },
    workspaceId,
  );
  if (result.error !== undefined) throwServiceError(result);
  return { data: result.data };
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const { userId, workspaceId } = requireUserContext(context.iam);

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

  const result = await savedView.remove(input.id, { actorId: userId }, workspaceId);
  if (result.error !== undefined) {
    throwServiceError({ error: result.error, code: result.code ?? "BAD_REQUEST" });
  }
  return { success: true };
});

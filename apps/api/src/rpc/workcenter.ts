import { z } from "zod";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { workcenter } from "@rw/services/facility/index";
import { authorize, authorizeList, scopeFilter } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";
import { throwServiceError, unwrap } from "./errors.js";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  siteId: z.uuid(),
  parentId: z.uuid().optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const moveInputSchema = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  parentId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Procedures
// ============================================================================

/**
 * Create a new workcenter
 */
export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "facility:write", site: { kind: "site", siteId: input.siteId } }));

  const result = await workcenter.create(input);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * List workcenters
 */
export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorizeList(context.iam, { permission: "facility:read", requestedSiteId: input.siteId }));
  return workcenter.list({ ...input, ...scopeFilter(scope) });
});

/**
 * Get workcenter by ID
 */
export const get = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "facility:read", site: { kind: "workcenter", workcenterId: input.id } }),
  );

  const result = await workcenter.getById(input.id, scope.workspaceId);
  return unwrap(result, { notFoundMessage: "Workcenter not found" });
});

/**
 * Update workcenter
 */
export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updateData } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "facility:write", site: { kind: "workcenter", workcenterId: id } }),
  );

  const result = await workcenter.update(id, updateData, scope.workspaceId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Move workcenter to a new parent (within same site)
 */
export const move = authRequired.input(moveInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, {
      permission: "facility:write",
      site: { kind: "workcenter", workcenterId: input.id },
    }),
  );

  const result = await workcenter.move(input.id, input.parentId, scope.workspaceId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Delete workcenter
 */
export const remove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, {
      permission: "facility:admin",
      site: { kind: "workcenter", workcenterId: input.id },
    }),
  );

  const result = await workcenter.remove(input.id, scope.workspaceId);
  // HAS_CHILDREN / HAS_STATIONS map to CONFLICT via the shared table
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

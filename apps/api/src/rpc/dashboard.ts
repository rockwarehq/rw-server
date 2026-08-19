import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { authorize, authorizeList } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";
import { dashboard } from "@rw/services/dashboard/index";
import { throwServiceError } from "./errors.js";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  spec: z.record(z.string(), z.unknown()).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  spec: z.record(z.string(), z.unknown()).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Procedures
// ============================================================================

/**
 * Create a new dashboard
 */
export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "dashboard:write", scope: { kind: "site", siteId: input.siteId } }),
  );

  const result = await dashboard.create(input, workspaceId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * List dashboards
 */
export const list = userOrDisplayRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorizeList(context.iam, { permission: "dashboard:read", requestedSiteId: input.siteId }),
  );

  return dashboard.list({ ...input, siteId: scope.siteId }, scope.workspaceId);
});

/**
 * Get dashboard by ID
 */
export const get = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "dashboard:read", scope: { kind: "dashboard", id: input.id } }),
  );

  const result = await dashboard.getById(input.id, workspaceId);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Dashboard not found" });
  }
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Update dashboard
 */
export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "dashboard:write", scope: { kind: "dashboard", id: input.id } }),
  );

  const { id, ...updateData } = input;
  const result = await dashboard.update(id, updateData, workspaceId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Delete dashboard (soft delete)
 */
export const remove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "dashboard:admin", scope: { kind: "dashboard", id: input.id } }),
  );

  const result = await dashboard.remove(input.id, workspaceId);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

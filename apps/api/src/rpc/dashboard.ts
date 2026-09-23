import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { userRequired, userOrDisplayRequired } from "./middleware.js";
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
export const create = userRequired.input(createInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { site: input.siteId });
  const { workspaceId } = context.current;

  const result = await dashboard.create(input, workspaceId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * List dashboards
 */
export const list = userOrDisplayRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = context.access.list("VIEW", input.siteId);

  return dashboard.list({ ...input, siteId: scope.siteId });
});

/**
 * Get dashboard by ID
 */
export const get = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { dashboard: input.id });
  const { workspaceId } = context.current;

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
export const update = userRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { dashboard: input.id });
  const { workspaceId } = context.current;

  const { id, ...updateData } = input;
  const result = await dashboard.update(id, updateData, workspaceId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Delete dashboard (soft delete)
 */
export const remove = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { dashboard: input.id });
  const { workspaceId } = context.current;

  const result = await dashboard.remove(input.id, workspaceId);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

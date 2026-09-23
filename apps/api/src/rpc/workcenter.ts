import { z } from "zod";
import { userRequired, userOrDisplayRequired } from "./middleware.js";
import { workcenter } from "@rw/services/facility/index";
import { throwServiceError, unwrap } from "./errors.js";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  siteId: z.uuid(),
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

// Nesting is unsupported; the only accepted move is to the top level
// (parentId: null), kept so pre-existing trees can be flattened.
const moveInputSchema = z.object({
  id: z.uuid(),
  parentId: z.null(),
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
export const create = userRequired.input(createInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { site: input.siteId });

  const result = await workcenter.create(input);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * List workcenters
 */
export const list = userRequired.input(listInputSchema).handler(async ({ input, context }) => {
  // The workcenter directory is a plant thing: every member may read it.
  const scope = context.access.list("VIEW", input.siteId);
  return workcenter.list({ ...input, ...scope });
});

/**
 * Get workcenter by ID
 */
export const get = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { workcenter: input.id });

  const result = await workcenter.getById(input.id);
  return unwrap(result, { notFoundMessage: "Workcenter not found" });
});

/**
 * Update workcenter
 */
export const update = userRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updateData } = input;
  await context.access.require("MANAGE", { workcenter: id });

  const result = await workcenter.update(id, updateData);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Move workcenter to a new parent (within same site)
 */
export const move = userRequired.input(moveInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { workcenter: input.id });

  const result = await workcenter.move(input.id, input.parentId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Delete workcenter
 */
export const remove = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { workcenter: input.id });

  const result = await workcenter.remove(input.id);
  // HAS_CHILDREN / HAS_STATIONS map to CONFLICT via the shared table
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

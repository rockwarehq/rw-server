import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { tool, job } from "@rw/services/job/index";
import { type CodeOverrides, throwServiceError, unwrap } from "./errors.js";

// Historical mappings that predate the shared mapper — pinned because
// observable error codes are API (@rockwarehq/rpc-client is published):
// - NO_CURRENT_VERSION fell through to the catch-all BAD_REQUEST in this router
//   (shared default: CONFLICT).
// - The old handlers checked for HAS_JOB_ITEMS, a code the services never
//   emit; the actual HAS_JOB_PRODUCTS therefore always fell through to
//   BAD_REQUEST (shared default: CONFLICT).
const jobOverrides: CodeOverrides = {
  NO_CURRENT_VERSION: "BAD_REQUEST",
  HAS_JOB_PRODUCTS: "BAD_REQUEST",
};

// ============================================================================
// Input Schemas - Tool CRUD
// ============================================================================

const toolCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  cavityCount: z.number().int().positive().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const toolUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  cavityCount: z.number().int().positive().nullable().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const toolIdInputSchema = z.object({
  id: z.uuid(),
});

const toolListInputSchema = z.object({
  siteId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Input Schemas - Tool Cavity
// ============================================================================

const addCavityInputSchema = z.object({
  toolId: z.uuid(),
  name: z.string().min(1),
  position: z.number().int().optional(),
});

const updateCavityInputSchema = z.object({
  cavityId: z.uuid(),
  name: z.string().min(1).optional(),
  position: z.number().int().optional(),
});

const cavityIdInputSchema = z.object({
  cavityId: z.uuid(),
});

const listCavitiesInputSchema = z.object({
  toolId: z.uuid(),
});

// ============================================================================
// Input Schemas - Job CRUD
// ============================================================================

const jobCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  standardCycle: z.number().positive().optional(),
  productsPerCycle: z.number().int().positive().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const jobUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  standardCycle: z.number().positive().optional(),
  productsPerCycle: z.number().int().positive().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const jobIdInputSchema = z.object({
  id: z.uuid(),
});

const jobListInputSchema = z.object({
  siteId: z.uuid().optional(),
  q: z.string().optional(),
  name: z.string().optional(),
  productIds: z.array(z.uuid()).optional(),
  view: z.enum(["full", "slim"]).default("full"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Input Schemas - Job Tools
// ============================================================================

const addToolInputSchema = z.object({
  jobId: z.uuid(),
  toolId: z.uuid(),
});

const removeToolInputSchema = z.object({
  jobId: z.uuid(),
  toolId: z.uuid(),
});

const listToolsInputSchema = z.object({
  jobId: z.uuid(),
});

// ============================================================================
// Input Schemas - Job Items
// ============================================================================

const addItemInputSchema = z.object({
  jobId: z.uuid(),
  productId: z.uuid(),
  toolId: z.uuid().optional(),
  toolCavityId: z.uuid().optional(),
  quantity: z.number().int().positive().default(1),
});

const updateItemInputSchema = z.object({
  itemId: z.uuid(),
  isActive: z.boolean().optional(),
  toolId: z.uuid().nullable().optional(),
  toolCavityId: z.uuid().nullable().optional(),
  quantity: z.number().int().positive().optional(),
});

const itemIdInputSchema = z.object({
  itemId: z.uuid(),
});

const listItemsInputSchema = z.object({
  jobId: z.uuid(),
});

// ============================================================================
// Procedures - Tool CRUD
// ============================================================================

/**
 * Create a new tool
 */
export const toolCreate = authRequired.input(toolCreateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return unwrap(await tool.create(input));
});

/**
 * List tools with optional filters
 */
export const toolList = authRequired.input(toolListInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return tool.list(input);
});

/**
 * Get tool by ID
 */
export const toolGet = authRequired.input(toolIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return unwrap(await tool.getById(input.id), { notFoundMessage: "Tool not found" });
});

/**
 * Update tool (creates new version version)
 */
export const toolUpdate = authRequired.input(toolUpdateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const { id, ...updateData } = input;
  return unwrap(await tool.update(id, updateData), { overrides: jobOverrides });
});

/**
 * Delete tool (soft delete)
 */
export const toolRemove = authRequired.input(toolIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await tool.remove(input.id);
  if (result.error) throwServiceError(result, jobOverrides);
  return { success: true };
});

// ============================================================================
// Procedures - Tool Cavity
// ============================================================================

/**
 * Add a cavity to a tool
 */
export const toolAddCavity = authRequired.input(addCavityInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return unwrap(await tool.addCavity(input));
});

/**
 * Update a cavity (creates new version version)
 */
export const toolUpdateCavity = authRequired.input(updateCavityInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const { cavityId, ...updateData } = input;
  return unwrap(await tool.updateCavity(cavityId, updateData), { overrides: jobOverrides });
});

/**
 * Remove a cavity (soft delete)
 */
export const toolRemoveCavity = authRequired.input(cavityIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await tool.removeCavity(input.cavityId);
  if (result.error) throwServiceError(result, jobOverrides);
  return { success: true };
});

/**
 * List cavities for a tool
 */
export const toolListCavities = authRequired.input(listCavitiesInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return unwrap(await tool.listCavities(input.toolId));
});

// ============================================================================
// Procedures - Job CRUD
// ============================================================================

/**
 * Create a new job
 */
export const create = authRequired.input(jobCreateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return unwrap(await job.create(input));
});

/**
 * List jobs with optional filters
 */
export const list = userOrDisplayRequired.input(jobListInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return job.list(input);
});

/**
 * Get job by ID
 */
export const get = userOrDisplayRequired.input(jobIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return unwrap(await job.getById(input.id), { notFoundMessage: "Job not found" });
});

/**
 * Update job (creates new version version)
 */
export const update = authRequired.input(jobUpdateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const { id, ...updateData } = input;
  return unwrap(await job.update(id, updateData), { overrides: jobOverrides });
});

/**
 * Delete job (soft delete)
 */
export const remove = authRequired.input(jobIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await job.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

// ============================================================================
// Procedures - Job Tools (linking tools to jobs)
// ============================================================================

/**
 * Add a tool to a job
 */
export const addTool = authRequired.input(addToolInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return unwrap(await job.addTool(input));
});

/**
 * Remove a tool from a job
 */
export const removeTool = authRequired.input(removeToolInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await job.removeTool(input.jobId, input.toolId);
  if (result.error) throwServiceError(result);
  return { success: true };
});

/**
 * List tools linked to a job
 */
export const listTools = userOrDisplayRequired.input(listToolsInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return unwrap(await job.listTools(input.jobId));
});

// ============================================================================
// Procedures - Job Items (linking products to jobs)
// ============================================================================

/**
 * Add a product (item) to a job
 */
export const addItem = authRequired.input(addItemInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return unwrap(await job.addItem(input));
});

/**
 * Update a job item
 */
export const updateItem = authRequired.input(updateItemInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const { itemId, ...updateData } = input;
  return unwrap(await job.updateItem(itemId, updateData), { overrides: jobOverrides });
});

/**
 * Remove a job item (soft delete)
 */
export const removeItem = authRequired.input(itemIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await job.removeItem(input.itemId);
  if (result.error) throwServiceError(result);
  return { success: true };
});

/**
 * List items for a job
 */
export const listItems = userOrDisplayRequired.input(listItemsInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return unwrap(await job.listItems(input.jobId));
});

/**
 * Get jobs capable of producing the given products
 */
const jobsByProductIdsInputSchema = z.object({
  siteId: z.uuid(),
  productIds: z.array(z.uuid()),
});

export const jobsByProductIds = authRequired.input(jobsByProductIdsInputSchema).handler(async ({ input }) => {
  const result = await job.jobsByProductIds(input.siteId, input.productIds);
  return result.data;
});

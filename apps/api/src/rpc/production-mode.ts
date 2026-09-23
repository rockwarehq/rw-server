import { z } from "zod";
import { userRequired, userOrDisplayRequired } from "./middleware.js";
import { productionMode } from "@rw/services/facility/index";
import { throwServiceError, unwrap } from "./errors.js";

// ============================================================================
// Input Schemas
// ============================================================================

const roleIdsSchema = z.array(z.uuid()).max(100);

const createInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  scrapAll: z.boolean().optional(),
  // Required when scrapAll; the disposition is always the site's "Scrap".
  dispositionReasonId: z.uuid().nullable().optional(),
  // Downtime beginning under this mode defaults to this reason.
  statusReasonId: z.uuid().nullable().optional(),
  roleIds: roleIdsSchema.optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  scrapAll: z.boolean().optional(),
  dispositionReasonId: z.uuid().nullable().optional(),
  statusReasonId: z.uuid().nullable().optional(),
  // Whole-list replacement; [] clears the restriction.
  roleIds: roleIdsSchema.optional(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  includeArchived: z.boolean().default(false),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const forceInputSchema = z.object({
  stationId: z.uuid(),
  modeId: z.uuid(),
  // Display flows pass the logged-on operator explicitly; USER principals
  // resolve through their workspace membership's employee link instead.
  employeeId: z.uuid().optional(),
});

const clearInputSchema = z.object({
  stationId: z.uuid(),
  employeeId: z.uuid().optional(),
});

const listLogsInputSchema = z.object({
  stationId: z.uuid(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Catalog Procedures
// ============================================================================

export const create = userRequired.input(createInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { site: input.siteId });

  const result = await productionMode.create(input);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const list = userOrDisplayRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = context.access.list("VIEW", input.siteId);
  return productionMode.list({ ...input, siteId: scope.siteId });
});

export const get = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { productionMode: input.id });

  const result = await productionMode.getById(input.id);
  return unwrap(result, { notFoundMessage: "Production mode not found" });
});

export const update = userRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { productionMode: input.id });

  const { id, ...updateData } = input;
  const result = await productionMode.update(id, updateData);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const archive = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { productionMode: input.id });

  const result = await productionMode.archive(input.id);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

// ============================================================================
// Force / Clear / Audit Trail
// ============================================================================

export const force = userOrDisplayRequired.input(forceInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { station: input.stationId });

  // Everyone past this gate may skip the mode's role limits: users here
  // hold MANAGE, and displays always could (unchanged from before buckets).

  const result = await productionMode.force({
    stationId: input.stationId,
    modeId: input.modeId,
    employeeId: input.employeeId,
    userId: context.current.kind === "user" ? context.current.user.id : undefined,
    bypassRoles: true,
  });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const clear = userOrDisplayRequired.input(clearInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { station: input.stationId });

  // Everyone past this gate may skip the mode's role limits: users here
  // hold MANAGE, and displays always could (unchanged from before buckets).

  const result = await productionMode.clear({
    stationId: input.stationId,
    employeeId: input.employeeId,
    userId: context.current.kind === "user" ? context.current.user.id : undefined,
    bypassRoles: true,
  });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const listLogs = userOrDisplayRequired.input(listLogsInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { station: input.stationId });
  return productionMode.listLogs(input);
});

import { z } from "zod";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { authorizeReferenceRead, scopeFilter } from "@rw/auth/iam/policy";
import {
  authorizeTerminalAction,
  authorizeReferenceList,
  hasProductionAdmin,
  resolveTerminalActor,
  authorizeSiteOperation,
} from "./terminal-authz.js";
import { grant } from "./authz.js";
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
  operatorSessionId: z.uuid().optional(),
});

const clearInputSchema = z.object({
  stationId: z.uuid(),
  employeeId: z.uuid().optional(),
  operatorSessionId: z.uuid().optional(),
});

const listLogsInputSchema = z.object({
  stationId: z.uuid(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Catalog Procedures
// ============================================================================

export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  await authorizeSiteOperation(context.iam, "configuration:write", { kind: "site", siteId: input.siteId });

  const result = await productionMode.create(input);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const list = userOrDisplayRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = await authorizeReferenceList(context.iam, input.siteId);
  return productionMode.list({ ...input, ...scopeFilter(scope) });
});

export const get = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorizeReferenceRead(context.iam, { scope: { kind: "productionMode", id: input.id } }));

  const result = await productionMode.getById(input.id);
  return unwrap(result, { notFoundMessage: "Production mode not found" });
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  await authorizeSiteOperation(context.iam, "configuration:write", { kind: "productionMode", id: input.id });

  const { id, ...updateData } = input;
  const result = await productionMode.update(id, updateData);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const archive = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await authorizeSiteOperation(context.iam, "configuration:write", { kind: "productionMode", id: input.id });

  const result = await productionMode.archive(input.id);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

// ============================================================================
// Force / Clear / Audit Trail
// ============================================================================

export const force = userOrDisplayRequired.input(forceInputSchema).handler(async ({ input, context }) => {
  const location = await authorizeTerminalAction(context.iam, {
    action: "mode.force",
    scope: { kind: "station", id: input.stationId },
  });
  const actor = await resolveTerminalActor(context.iam, location, input);
  const admin = await hasProductionAdmin(context.iam, location);

  const result = await productionMode.force({
    stationId: input.stationId,
    modeId: input.modeId,
    employeeId: actor.employeeId ?? undefined,
    userId: actor.userId,
    bypassRoles: admin,
  });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const clear = userOrDisplayRequired.input(clearInputSchema).handler(async ({ input, context }) => {
  const location = await authorizeTerminalAction(context.iam, {
    action: "mode.clear",
    scope: { kind: "station", id: input.stationId },
  });
  const actor = await resolveTerminalActor(context.iam, location, input);
  const admin = await hasProductionAdmin(context.iam, location);

  const result = await productionMode.clear({
    stationId: input.stationId,
    employeeId: actor.employeeId ?? undefined,
    userId: actor.userId,
    bypassRoles: admin,
  });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const listLogs = userOrDisplayRequired.input(listLogsInputSchema).handler(async ({ input, context }) => {
  await authorizeTerminalAction(context.iam, {
    action: "production.read",
    scope: { kind: "station", id: input.stationId },
  });
  return productionMode.listLogs(input);
});

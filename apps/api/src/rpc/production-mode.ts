import { z } from "zod";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { authorize, authorizeList, scopeFilter } from "@rw/auth/iam/policy";
import { Principal } from "../auth/index.js";
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

export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "modes:admin", scope: { kind: "site", siteId: input.siteId } }));

  const result = await productionMode.create(input);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const list = userOrDisplayRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorizeList(context.iam, { permission: "modes:read", requestedSiteId: input.siteId }));
  return productionMode.list({ ...input, ...scopeFilter(scope) });
});

export const get = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "modes:read", scope: { kind: "productionMode", id: input.id } }));

  const result = await productionMode.getById(input.id);
  return unwrap(result, { notFoundMessage: "Production mode not found" });
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "modes:admin", scope: { kind: "productionMode", id: input.id } }));

  const { id, ...updateData } = input;
  const result = await productionMode.update(id, updateData);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const archive = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "modes:admin", scope: { kind: "productionMode", id: input.id } }));

  const result = await productionMode.archive(input.id);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

// ============================================================================
// Force / Clear / Audit Trail
// ============================================================================

export const force = userOrDisplayRequired.input(forceInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "modes:write", scope: { kind: "station", id: input.stationId } }));

  // modes:admin bypasses mode role restrictions so an office supervisor can
  // always change a station's mode (quiet check — no throw).
  const admin = await authorize(context.iam, {
    permission: "modes:admin",
    scope: { kind: "station", id: input.stationId },
  });

  const result = await productionMode.force({
    stationId: input.stationId,
    modeId: input.modeId,
    employeeId: input.employeeId,
    userId: context.iam.principal === Principal.USER ? context.iam.id : undefined,
    bypassRoles: admin.ok,
  });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const clear = userOrDisplayRequired.input(clearInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "modes:write", scope: { kind: "station", id: input.stationId } }));

  const admin = await authorize(context.iam, {
    permission: "modes:admin",
    scope: { kind: "station", id: input.stationId },
  });

  const result = await productionMode.clear({
    stationId: input.stationId,
    employeeId: input.employeeId,
    userId: context.iam.principal === Principal.USER ? context.iam.id : undefined,
    bypassRoles: admin.ok,
  });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const listLogs = userOrDisplayRequired.input(listLogsInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "modes:read", scope: { kind: "station", id: input.stationId } }));
  return productionMode.listLogs(input);
});

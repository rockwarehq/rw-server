import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { site } from "@rw/services/facility/index";
import { Principal } from "../auth/index.js";
import { authorize, authorizeAccessibleSites } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";
import { throwServiceError, unwrap } from "./errors.js";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  timezone: z.string().min(1).optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const listInputSchema = z.object({
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Procedures
// ============================================================================

/**
 * Create a new site
 */
export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "facility:write", site: { kind: "workspace" } }));

  const result = await site.create({ ...input, workspaceId: scope.workspaceId });
  return unwrap(result);
});

/**
 * List sites in workspace
 */
export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  // Site directory: the sanctioned cross-site surface (site picker/admin).
  const scope = grant(await authorizeAccessibleSites(context.iam, { permission: "facility:read" }));
  return site.list({ ...input, workspaceId: scope.workspaceId, siteIds: scope.siteIds });
});

/**
 * Get site by ID
 */
export const get = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "facility:read", site: { kind: "site", siteId: input.id } }),
  );

  const result = await site.getById(input.id, scope.workspaceId);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Site not found" });
  }
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

const treeInputSchema = z.object({
  siteId: z.uuid().optional(),
});

/**
 * Get site tree (Site -> Workcenter -> Station)
 * If siteId is provided, returns single site tree
 * If siteId is omitted, returns all sites in workspace
 */
export const tree = userOrDisplayRequired.input(treeInputSchema).handler(async ({ input, context }) => {
  if (context.iam.principal === Principal.DISPLAY) {
    const ownSiteId = context.iam.siteId;
    if (!ownSiteId) {
      throw new ORPCError("BAD_REQUEST", { message: "Display site context required" });
    }

    const scope = grant(
      await authorize(context.iam, {
        permission: "facility:read",
        site: { kind: "site", siteId: input.siteId ?? ownSiteId },
      }),
    );

    const result = await site.getSiteTree(scope.siteId, scope.workspaceId);
    if (result.error !== undefined) throwServiceError(result);

    // Explicit siteId returns a single tree; the bare call keeps the
    // list-of-trees shape used by the workspace-wide user variant.
    return input.siteId ? result.data : [result.data];
  }

  // If siteId provided, return single site tree
  if (input.siteId) {
    const scope = grant(
      await authorize(context.iam, { permission: "facility:read", site: { kind: "site", siteId: input.siteId } }),
    );
    const result = await site.getSiteTree(input.siteId, scope.workspaceId);
    if (result.error !== undefined) throwServiceError(result);
    return result.data;
  }

  // No siteId, return the accessible-site tree (site directory surface)
  const scope = grant(await authorizeAccessibleSites(context.iam, { permission: "facility:read" }));
  return site.getTree(scope.workspaceId, scope.siteIds);
});

/**
 * Update site
 */
export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updateData } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "facility:write", site: { kind: "site", siteId: id } }),
  );

  const result = await site.update(id, updateData, scope.workspaceId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Delete site
 */
export const remove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "facility:admin", site: { kind: "site", siteId: input.id } }),
  );

  const result = await site.remove(input.id, scope.workspaceId);
  // HAS_WORKCENTERS / HAS_GATEWAYS / HAS_DATASOURCES map to CONFLICT via the shared table
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

const siteIdInputSchema = z.object({
  siteId: z.uuid(),
});

/**
 * Get device tree for a site (Gateway -> Datasources)
 * Returns all gateways with their assigned datasources (all statuses)
 */
export const deviceTree = authRequired.input(siteIdInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "facility:read", site: { kind: "site", siteId: input.siteId } }),
  );

  const result = await site.getDeviceTree(input.siteId, scope.workspaceId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

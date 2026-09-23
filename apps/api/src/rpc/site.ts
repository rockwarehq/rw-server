import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { site } from "@rw/services/facility/index";
import { Principal } from "../auth/index.js";
import { authorize, authorizeAccessibleSites } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";
import { throwServiceError, unwrap } from "./errors.js";
import { storageConfig } from "../config.js";

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

const updateSettingsInputSchema = z.object({
  id: z.uuid(),
  settings: z.object({
    orderAutoComplete: z.boolean().optional(),
    // Gated (like the rest of settings) on configuration:write — gating this one
    // key on configuration:write would be theater while the generic site.update
    // writes arbitrary attrs under configuration:write. WRITE workcenter grants
    // confer configuration:write only workcenter-scoped, so grant holders cannot
    // flip it.
    baseWorkcenterAccess: z.enum(["ALL", "GRANTS_REQUIRED"]).optional(),
  }),
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
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "workspace" } }),
  );

  const result = await site.create({ ...input, workspaceId: scope.workspaceId });
  return unwrap(result);
});

/**
 * List sites in workspace
 */
export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  // Site directory: the sanctioned cross-site surface (site picker/admin).
  // Membership visibility — any assignment or grant at a site lists it.
  const scope = grant(await authorizeAccessibleSites(context.iam, {}));
  const result = await site.list({ ...input, workspaceId: scope.workspaceId, siteIds: scope.siteIds });
  return {
    ...result,
    data: await Promise.all(result.data.map(async (s) => ({ ...s, logoUrl: await site.resolveLogoUrl(s.attrs) }))),
  };
});

/**
 * Get site by ID
 */
export const get = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  // Shared reference read: production OR planning visibility both qualify.
  const production = await authorize(context.iam, {
    permission: "production:read",
    scope: { kind: "site", siteId: input.id },
  });
  const scope = grant(
    production.ok
      ? production
      : await authorize(context.iam, { permission: "planning:read", scope: { kind: "site", siteId: input.id } }),
  );

  const result = await site.getById(input.id, scope.workspaceId);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Site not found" });
  }
  if (result.error !== undefined) throwServiceError(result);
  return { ...result.data, logoUrl: await site.resolveLogoUrl(result.data.attrs) };
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
        permission: "production:read",
        scope: { kind: "site", siteId: input.siteId ?? ownSiteId },
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
    // Shared reference read: production OR planning visibility both qualify.
    const production = await authorize(context.iam, {
      permission: "production:read",
      scope: { kind: "site", siteId: input.siteId },
    });
    const scope = grant(
      production.ok
        ? production
        : await authorize(context.iam, { permission: "planning:read", scope: { kind: "site", siteId: input.siteId } }),
    );
    const result = await site.getSiteTree(input.siteId, scope.workspaceId);
    if (result.error !== undefined) throwServiceError(result);
    return result.data;
  }

  // No siteId, return the visible-site tree (site directory surface)
  const scope = grant(await authorizeAccessibleSites(context.iam, {}));
  return site.getTree(scope.workspaceId, scope.siteIds);
});

/**
 * Read the typed site settings (fulfillment automation, …).
 */
export const getSettings = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  // Shared reference read: production OR planning visibility both qualify.
  const production = await authorize(context.iam, {
    permission: "production:read",
    scope: { kind: "site", siteId: input.id },
  });
  grant(
    production.ok
      ? production
      : await authorize(context.iam, { permission: "planning:read", scope: { kind: "site", siteId: input.id } }),
  );

  return unwrap(await site.getSiteSettings(input.id));
});

/**
 * Update typed site settings — merges only known keys into Site.attrs.
 */
export const updateSettings = authRequired.input(updateSettingsInputSchema).handler(async ({ input, context }) => {
  // baseWorkcenterAccess is an ACCESS-CONTROL policy (who sees the floor),
  // so changing it is plant administration, not technical setup.
  const permission = input.settings.baseWorkcenterAccess !== undefined ? "plant:admin" : "configuration:write";
  grant(await authorize(context.iam, { permission, scope: { kind: "site", siteId: input.id } }));

  return unwrap(await site.updateSiteSettings(input.id, input.settings));
});

/**
 * Update site
 */
export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updateData } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "site", siteId: id } }),
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
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "site", siteId: input.id } }),
  );

  const result = await site.remove(input.id, scope.workspaceId);
  // HAS_WORKCENTERS / HAS_GATEWAYS / HAS_DATASOURCES map to CONFLICT via the shared table
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

const uploadLogoInputSchema = z.object({
  id: z.uuid(),
  filename: z.string().min(1),
  contentType: z.string().refine((ct) => storageConfig.allowedContentTypes.includes(ct), {
    message: `Content type must be one of: ${storageConfig.allowedContentTypes.join(", ")}`,
  }),
  size: z
    .number()
    .int()
    .positive()
    .max(storageConfig.maxFileSizeBytes, {
      message: `File size must not exceed ${storageConfig.maxFileSizeBytes / (1024 * 1024)}MB`,
    }),
});

/**
 * Start a site logo upload — writes attrs.logo and returns a presigned PUT
 * URL. Replaces any existing logo; callers roll back a failed PUT via
 * removeLogo.
 */
export const uploadLogo = authRequired.input(uploadLogoInputSchema).handler(async ({ input, context }) => {
  const { id, ...upload } = input;
  const scope = grant(await authorize(context.iam, { permission: "plant:admin", scope: { kind: "site", siteId: id } }));

  return unwrap(await site.createLogoUpload(id, upload, scope.workspaceId));
});

/**
 * Remove the site logo (idempotent)
 */
export const removeLogo = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "plant:admin", scope: { kind: "site", siteId: input.id } }),
  );

  return unwrap(await site.removeLogo(input.id, scope.workspaceId));
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
    await authorize(context.iam, { permission: "configuration:read", scope: { kind: "site", siteId: input.siteId } }),
  );

  const result = await site.getDeviceTree(input.siteId, scope.workspaceId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

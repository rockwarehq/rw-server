import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { userRequired, userOrDisplayRequired } from "./middleware.js";
import { site } from "@rw/services/facility/index";
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
export const create = userRequired.input(createInputSchema).handler(async ({ input, context }) => {
  context.access.requireAccountAdmin();

  const result = await site.create({ ...input, workspaceId: context.current.workspaceId });
  return unwrap(result);
});

/**
 * List sites in workspace
 */
export const list = userRequired.input(listInputSchema).handler(async ({ input, context }) => {
  // Site directory: the sanctioned cross-site surface (site picker/admin).
  // Membership visibility — any assignment or grant at a site lists it.
  const sites = context.access.sites();
  const result = await site.list({
    ...input,
    workspaceId: context.current.workspaceId,
    siteIds: sites === "all" ? undefined : sites,
  });
  return {
    ...result,
    data: await Promise.all(result.data.map(async (s) => ({ ...s, logoUrl: await site.resolveLogoUrl(s.attrs) }))),
  };
});

/**
 * Get site by ID
 */
export const get = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { site: input.id });

  const result = await site.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Site not found" });
  }
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
  if (context.current.kind === "display") {
    const scope = await context.access.require("VIEW", { site: input.siteId ?? context.current.siteId });

    const result = await site.getSiteTree(scope.siteId);
    if (result.error !== undefined) throwServiceError(result);

    // Explicit siteId returns a single tree; the bare call keeps the
    // list-of-trees shape used by the workspace-wide user variant.
    return input.siteId ? result.data : [result.data];
  }

  // If siteId provided, return single site tree
  if (input.siteId) {
    await context.access.require("VIEW", { site: input.siteId });
    const result = await site.getSiteTree(input.siteId);
    if (result.error !== undefined) throwServiceError(result);
    return result.data;
  }

  // No siteId, return the visible-site tree (site directory surface)
  const sites = context.access.sites();
  return site.getTree(context.current.workspaceId, sites === "all" ? undefined : sites);
});

/**
 * Read the typed site settings (fulfillment automation, …).
 */
export const getSettings = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { site: input.id });

  return unwrap(await site.getSiteSettings(input.id));
});

/**
 * Update typed site settings — merges only known keys into Site.attrs.
 */
export const updateSettings = userRequired.input(updateSettingsInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.id });

  return unwrap(await site.updateSiteSettings(input.id, input.settings));
});

/**
 * Update site
 */
export const update = userRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updateData } = input;
  await context.access.require("ADMIN", { site: id });

  const result = await site.update(id, updateData);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Delete site
 */
export const remove = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  // Sites are account-level: only the owner adds or removes them.
  context.access.requireAccountAdmin();

  const result = await site.remove(input.id);
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
export const uploadLogo = userRequired.input(uploadLogoInputSchema).handler(async ({ input, context }) => {
  const { id, ...upload } = input;
  await context.access.require("ADMIN", { site: id });

  return unwrap(await site.createLogoUpload(id, upload));
});

/**
 * Remove the site logo (idempotent)
 */
export const removeLogo = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.id });

  return unwrap(await site.removeLogo(input.id));
});

const siteIdInputSchema = z.object({
  siteId: z.uuid(),
});

/**
 * Get device tree for a site (Gateway -> Datasources)
 * Returns all gateways with their assigned datasources (all statuses)
 */
export const deviceTree = userRequired.input(siteIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { site: input.siteId });

  const result = await site.getDeviceTree(input.siteId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

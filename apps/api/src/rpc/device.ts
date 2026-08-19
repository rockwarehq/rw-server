import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired } from "./middleware.js";
import { authorize, authorizeList, scopeFilter } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";
import { gateway, datasource } from "../services/device/index.js";
import { throwServiceError } from "./errors.js";

// ============================================================================
// Gateway Input Schemas
// ============================================================================

const gatewayCreateInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  hosting: z.enum(["SELF", "ROCKWARE"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  siteId: z.uuid(),
});

const gatewayUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  hosting: z.enum(["SELF", "ROCKWARE"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  siteId: z.uuid().optional(),
});

const gatewayIdInputSchema = z.object({
  id: z.uuid(),
});

const gatewayListInputSchema = z.object({
  siteId: z.uuid().optional(),
  /** Workspace pool view: only gateways not yet assigned to a site. */
  unassigned: z.boolean().optional(),
});

// ============================================================================
// Datasource Input Schemas
// ============================================================================

const datasourceCreateInputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["DEVICE", "KIOSK", "SERVICE", "VIRTUAL"]).optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  driver: z.string().min(1),
  driverVersion: z.string().optional(),
  connection: z.record(z.string(), z.unknown()).optional(),
  gatewayId: z.uuid().optional(),
  siteId: z.uuid(),
});

const datasourceUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  type: z.enum(["DEVICE", "KIOSK", "SERVICE", "VIRTUAL"]).optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  connection: z.record(z.string(), z.unknown()).optional(),
});

const datasourceIdInputSchema = z.object({
  id: z.uuid(),
});

const datasourceListInputSchema = z.object({
  siteId: z.uuid().optional(),
  gatewayId: z.uuid().optional(),
  driver: z.string().optional(),
  type: z.enum(["DEVICE", "KIOSK", "SERVICE", "VIRTUAL"]).optional(),
  status: z.enum(["DRAFT", "ACTIVE"]).optional(),
  name: z.string().optional(),
  unassigned: z.boolean().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Gateway Procedures
// ============================================================================

/**
 * Create a new gateway at a site
 */
export const gatewayCreate = authRequired.input(gatewayCreateInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "facility:write", site: { kind: "site", siteId: input.siteId } }),
  );

  const result = await gateway.create({ ...input, workspaceId });
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * List gateways (optionally filtered by siteId)
 */
export const gatewayList = authRequired.input(gatewayListInputSchema).handler(async ({ input, context }) => {
  if (input.unassigned) {
    // Workspace pool: claimed hardware awaiting site assignment — visible to
    // anyone who could assign it (facility:write held somewhere).
    const pool = grant(await authorize(context.iam, { permission: "facility:write", site: { kind: "anySite" } }));
    return gateway.list({ workspaceId: pool.workspaceId, unassigned: true });
  }

  const scope = grant(await authorizeList(context.iam, { permission: "facility:read", requestedSiteId: input.siteId }));
  return gateway.list(scopeFilter(scope));
});

/**
 * Get gateway by ID with details
 */
export const gatewayGet = authRequired.input(gatewayIdInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "facility:read", site: { kind: "gateway", id: input.id } }),
  );

  // gateway.getById only emits WORKSPACE_MISMATCH, which the shared table maps
  // to FORBIDDEN — same as the previous blanket FORBIDDEN here.
  const result = await gateway.getById(input.id, workspaceId);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Gateway not found" });
  }
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Update gateway
 */
export const gatewayUpdate = authRequired.input(gatewayUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updateData } = input;
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "facility:write", site: { kind: "gateway", id } }),
  );
  if (input.siteId) {
    // Moving a gateway requires facility:write at the TARGET site too.
    grant(await authorize(context.iam, { permission: "facility:write", site: { kind: "site", siteId: input.siteId } }));
  }

  const result = await gateway.update(id, { ...updateData, workspaceId });
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Delete gateway
 */
export const gatewayDelete = authRequired.input(gatewayIdInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "facility:admin", site: { kind: "gateway", id: input.id } }),
  );

  const result = await gateway.remove(input.id, workspaceId);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

// ============================================================================
// Datasource Procedures
// ============================================================================

/**
 * Create a new datasource (always creates as DRAFT)
 */
export const datasourceCreate = authRequired.input(datasourceCreateInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "facility:write", site: { kind: "site", siteId: input.siteId } }),
  );

  const result = await datasource.create({ ...input, workspaceId });
  if ("error" in result) {
    // intentional catch-all mapping — see ADR-0003 (service emits SITE_NOT_FOUND,
    // WORKSPACE_MISMATCH, DRIVER_NOT_FOUND, GATEWAY_NOT_FOUND, which the shared
    // mapper would surface as NOT_FOUND/FORBIDDEN; this endpoint has always
    // returned BAD_REQUEST for all of them)
    throw new ORPCError("BAD_REQUEST", {
      message: result.error,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Update datasource fields
 * - DRAFT: No connection validation (free editing)
 * - ACTIVE: Validates connection changes
 */
export const datasourceUpdate = authRequired.input(datasourceUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updateData } = input;
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "facility:write", site: { kind: "datasource", id } }),
  );

  const result = await datasource.update(id, updateData, workspaceId);

  if ("error" in result) {
    // intentional catch-all mapping — see ADR-0003 (NOT_FOUND / WORKSPACE_MISMATCH
    // / VALIDATION_FAILED all historically surface as BAD_REQUEST here)
    throw new ORPCError("BAD_REQUEST", {
      message: result.error,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Delete datasource
 */
export const datasourceDelete = authRequired.input(datasourceIdInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "facility:admin", site: { kind: "datasource", id: input.id } }),
  );

  const result = await datasource.remove(input.id, workspaceId);
  if ("error" in result) {
    // intentional catch-all mapping — see ADR-0003 (NOT_FOUND / WORKSPACE_MISMATCH
    // historically surface as BAD_REQUEST here)
    throw new ORPCError("BAD_REQUEST", {
      message: result.error,
      cause: result,
    });
  }
  return { success: true };
});

/**
 * Publish datasource (DRAFT -> ACTIVE)
 * Validates connection info exists and is valid against driver schema
 */
export const datasourcePublish = authRequired.input(datasourceIdInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "facility:write", site: { kind: "datasource", id: input.id } }),
  );

  const result = await datasource.publish(input.id, workspaceId);
  if ("error" in result) {
    // intentional catch-all mapping — see ADR-0003 (NOT_FOUND / WORKSPACE_MISMATCH /
    // INVALID_STATUS / CONNECTION_REQUIRED / VALIDATION_FAILED all historically
    // surface as BAD_REQUEST here)
    throw new ORPCError("BAD_REQUEST", {
      message: result.error,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Unpublish datasource (ACTIVE -> DRAFT)
 * Removes datasource from gateway sync
 */
export const datasourceUnpublish = authRequired.input(datasourceIdInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "facility:write", site: { kind: "datasource", id: input.id } }),
  );

  const result = await datasource.unpublish(input.id, workspaceId);
  if ("error" in result) {
    // intentional catch-all mapping — see ADR-0003 (NOT_FOUND / WORKSPACE_MISMATCH /
    // INVALID_STATUS historically surface as BAD_REQUEST here)
    throw new ORPCError("BAD_REQUEST", {
      message: result.error,
      cause: result,
    });
  }
  return result.data;
});

/**
 * List datasources with filtering and pagination
 * Automatically filtered by workspace
 */
export const datasourceList = authRequired.input(datasourceListInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorizeList(context.iam, { permission: "facility:read", requestedSiteId: input.siteId }));

  // Filter by workspace via site relationship
  return datasource.list({ ...input, ...scopeFilter(scope) });
});

/**
 * Get datasource by ID with related data
 */
export const datasourceGet = authRequired.input(datasourceIdInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "facility:read", site: { kind: "datasource", id: input.id } }),
  );

  const result = await datasource.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Datasource not found" });
  }

  // Validate workspace access via site
  const siteWorkspaceId = result.site?.workspaceId;
  if (workspaceId && siteWorkspaceId !== workspaceId) {
    throw new ORPCError("FORBIDDEN", { message: "Unauthorized" });
  }

  return result;
});

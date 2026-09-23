import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { userRequired } from "./middleware.js";
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
export const gatewayCreate = userRequired.input(gatewayCreateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { site: input.siteId });
  const { workspaceId } = context.current;

  const result = await gateway.create({ ...input, workspaceId });
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * List gateways (optionally filtered by siteId)
 */
export const gatewayList = userRequired.input(gatewayListInputSchema).handler(async ({ input, context }) => {
  if (input.unassigned) {
    // Workspace pool: claimed hardware awaiting site assignment — visible to
    // anyone who could assign it (MANAGE held somewhere).
    context.access.requireSomewhere("MANAGE");
    return gateway.list({ workspaceId: context.current.workspaceId, unassigned: true });
  }

  const scope = context.access.list("VIEW", input.siteId);
  return gateway.list({ workspaceId: context.current.workspaceId, siteId: scope.siteId });
});

/**
 * Get gateway by ID with details
 */
export const gatewayGet = userRequired.input(gatewayIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { gateway: input.id });
  const { workspaceId } = context.current;

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
export const gatewayUpdate = userRequired.input(gatewayUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updateData } = input;
  await context.access.require("MANAGE", { gateway: id });
  const { workspaceId } = context.current;
  if (input.siteId) {
    // Moving a gateway requires MANAGE at the TARGET site too.
    await context.access.require("MANAGE", { site: input.siteId });
  }

  const result = await gateway.update(id, { ...updateData, workspaceId });
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Delete gateway
 */
export const gatewayDelete = userRequired.input(gatewayIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { gateway: input.id });
  const { workspaceId } = context.current;

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
export const datasourceCreate = userRequired.input(datasourceCreateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { site: input.siteId });
  const { workspaceId } = context.current;

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
export const datasourceUpdate = userRequired.input(datasourceUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updateData } = input;
  await context.access.require("MANAGE", { datasource: id });
  const { workspaceId } = context.current;

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
export const datasourceDelete = userRequired.input(datasourceIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { datasource: input.id });
  const { workspaceId } = context.current;

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
export const datasourcePublish = userRequired.input(datasourceIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { datasource: input.id });
  const { workspaceId } = context.current;

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
export const datasourceUnpublish = userRequired.input(datasourceIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { datasource: input.id });
  const { workspaceId } = context.current;

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
export const datasourceList = userRequired.input(datasourceListInputSchema).handler(async ({ input, context }) => {
  const scope = context.access.list("VIEW", input.siteId);

  // Filter by workspace via site relationship
  return datasource.list({ ...input, siteId: scope.siteId });
});

/**
 * Get datasource by ID with related data
 */
export const datasourceGet = userRequired.input(datasourceIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { datasource: input.id });
  const { workspaceId } = context.current;

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

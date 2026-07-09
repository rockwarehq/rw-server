import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { publicProcedure, authRequired } from "./middleware.js";
import { display } from "@rw/services/display/index";
import { throwServiceError, unwrap } from "./errors.js";
import { Principal } from "../auth/index.js";

// ============================================================================
// Input Schemas
// ============================================================================

const idInputSchema = z.object({
  id: z.uuid(),
});

const claimInputSchema = z.object({
  claimCode: z.string().min(1),
  name: z.string().min(1),
  siteId: z.uuid(),
});

const assignDashboardInputSchema = z.object({
  id: z.uuid(),
  dashboardId: z.uuid(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  workcenterId: z.uuid().nullable().optional(),
  stationId: z.uuid().nullable().optional(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  status: z.enum(["UNCLAIMED", "CLAIMED"]).optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Public Procedures (no auth - used by TVs/tablets)
// ============================================================================

/**
 * Register a new unclaimed display
 * Called by the TV/tablet when it first opens /display
 */
export const register = publicProcedure.handler(async () => {
  return unwrap(await display.register());
});

/**
 * Get display by ID (includes dashboard spec/state)
 * Called by the TV/tablet to poll for claim status and get dashboard data
 */
export const get = publicProcedure.input(idInputSchema).handler(async ({ input }) => {
  return unwrap(await display.getById(input.id), { notFoundMessage: "Display not found" });
});

/**
 * Heartbeat - update lastSeenAt timestamp
 * Called by the TV/tablet periodically
 */
export const heartbeat = publicProcedure.input(idInputSchema).handler(async ({ input, context }) => {
  const claimedDisplay = await display.getClaimedDisplayForAuth(input.id);
  if (claimedDisplay) {
    if (!context.iam?.validToken || context.iam.principal !== Principal.DISPLAY || context.iam.displayId !== input.id) {
      // Disabling check for now, may not be needed and causes race condition between claiming display and getting auth token
      // throw new ORPCError("UNAUTHORIZED", { message: "Display authentication required" });
    }
  }

  const result = await display.heartbeat(input.id);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

// ============================================================================
// Authenticated Procedures (workspace management)
// ============================================================================

/**
 * Claim a display by its claim code
 */
export const claim = authRequired.input(claimInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await display.claim(workspaceId, input.claimCode, {
    name: input.name,
    siteId: input.siteId,
  });

  // Historical mapping: an unknown claim code reads as an absent resource,
  // not the shared default BAD_REQUEST.
  if (result.error !== undefined) throwServiceError(result, { INVALID_CLAIM_CODE: "NOT_FOUND" });
  return result.data;
});

/**
 * List displays for a site
 */
export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return display.listForWorkspace(workspaceId, input);
});

/**
 * Assign a dashboard to a display
 */
export const assignDashboard = authRequired.input(assignDashboardInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await display.assignDashboard(workspaceId, input.id, input.dashboardId);
  // Historical mapping: dashboard/display site mismatch is referential-input
  // BAD_REQUEST here, not the shared CONFLICT default.
  if (result.error !== undefined) throwServiceError(result, { SITE_MISMATCH: "BAD_REQUEST" });
  return result.data;
});

/**
 * Unassign dashboard from a display
 */
export const unassignDashboard = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await display.unassignDashboard(workspaceId, input.id);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Update display (rename)
 */
export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const { id, ...updateData } = input;
  const result = await display.update(workspaceId, id, updateData);
  // Historical mapping: workcenter/station are referential inputs on update,
  // so their absence is BAD_REQUEST rather than the shared NOT_FOUND default.
  if (result.error !== undefined) {
    throwServiceError(result, { WORKCENTER_NOT_FOUND: "BAD_REQUEST", STATION_NOT_FOUND: "BAD_REQUEST" });
  }
  return result.data;
});

/**
 * Delete display
 */
export const remove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await display.remove(workspaceId, input.id);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

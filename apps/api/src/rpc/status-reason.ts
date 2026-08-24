import { z } from "zod";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { authorize, authorizeList, scopeFilter } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";
import { statusReason } from "@rw/services/facility/index";
import { throwServiceError, unwrap } from "./errors.js";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  isPlannedDown: z.boolean().optional(),
  categoryId: z.uuid().nullable().optional(),
  labelIds: z.array(z.uuid()).max(50).optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  isPlannedDown: z.boolean().optional(),
  categoryId: z.uuid().nullable().optional(),
  // Replaces the code's whole label list with this one.
  labelIds: z.array(z.uuid()).max(50).optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  // Only return codes that have at least one of these labels.
  labelIds: z.array(z.uuid()).max(50).optional(),
  // Narrow to what this station's downtime-code filter allows.
  stationId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Procedures
// ============================================================================

export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "status:write", scope: { kind: "site", siteId: input.siteId } }));

  const result = await statusReason.create(input);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const list = userOrDisplayRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorizeList(context.iam, { permission: "status:read", requestedSiteId: input.siteId }));
  return statusReason.list({ ...input, ...scopeFilter(scope) });
});

export const get = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "status:read", scope: { kind: "statusReason", id: input.id } }));

  const result = await statusReason.getById(input.id);
  return unwrap(result, { notFoundMessage: "Status reason not found" });
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "status:write", scope: { kind: "statusReason", id: input.id } }));

  const { id, ...updateData } = input;
  const result = await statusReason.update(id, updateData);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const remove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "status:admin", scope: { kind: "statusReason", id: input.id } }));

  const result = await statusReason.remove(input.id);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

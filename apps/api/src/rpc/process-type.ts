import { z } from "zod";
import { authRequired } from "./middleware.js";
import { authorize, authorizeList, scopeFilter } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";
import { processType } from "@rw/services/facility/index";
import { throwServiceError, unwrap } from "./errors.js";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Procedures
// ============================================================================

export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "product:write", site: { kind: "site", siteId: input.siteId } }));

  return unwrap(await processType.create(input));
});

export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorizeList(context.iam, { permission: "product:read", requestedSiteId: input.siteId }));
  return processType.list({ ...input, ...scopeFilter(scope) });
});

export const get = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "product:read", site: { kind: "processType", id: input.id } }));

  return unwrap(await processType.getById(input.id), { notFoundMessage: "Process type not found" });
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "product:write", site: { kind: "processType", id: input.id } }));

  const { id, ...updateData } = input;
  return unwrap(await processType.update(id, updateData));
});

export const remove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "product:admin", site: { kind: "processType", id: input.id } }));

  const result = await processType.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

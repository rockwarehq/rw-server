import { z } from "zod";
import { authRequired } from "./middleware.js";
import { authorize, authorizeList, scopeFilter } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";
import * as customerService from "@rw/services/order/customer";
import { throwServiceError, unwrap } from "./errors.js";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1).max(255),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(255).optional(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  search: z.string().optional(),
  limit: z.number().min(0).default(200),
  offset: z.number().min(0).default(0),
});

const idInputSchema = z.object({ id: z.uuid() });

// ============================================================================
// Procedures
// ============================================================================

export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "job:write", site: { kind: "site", siteId: input.siteId } }));

  return unwrap(await customerService.create(input));
});

export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorizeList(context.iam, { permission: "job:read", requestedSiteId: input.siteId }));
  return customerService.list({ ...input, ...scopeFilter(scope) });
});

export const get = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "job:read", site: { kind: "customer", id: input.id } }));

  return unwrap(await customerService.getById(input.id));
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "job:write", site: { kind: "customer", id: input.id } }));

  const { id, ...updateData } = input;
  return unwrap(await customerService.update(id, updateData));
});

export const remove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "job:admin", site: { kind: "customer", id: input.id } }));

  const result = await customerService.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

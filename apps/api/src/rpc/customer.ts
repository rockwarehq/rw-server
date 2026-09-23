import { z } from "zod";
import { userRequired } from "./middleware.js";
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

export const create = userRequired.input(createInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { site: input.siteId });

  return unwrap(await customerService.create(input));
});

export const list = userRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = context.access.list("VIEW", input.siteId);
  return customerService.list({ ...input, siteId: scope.siteId });
});

export const get = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { customer: input.id });

  return unwrap(await customerService.getById(input.id));
});

export const update = userRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { customer: input.id });

  const { id, ...updateData } = input;
  return unwrap(await customerService.update(id, updateData));
});

export const remove = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { customer: input.id });

  const result = await customerService.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

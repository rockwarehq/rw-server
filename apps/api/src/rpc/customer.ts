import { z } from "zod";
import { authRequired } from "./middleware.js";
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

export const create = authRequired.input(createInputSchema).handler(async ({ input }) => {
  return unwrap(await customerService.create(input));
});

export const list = authRequired.input(listInputSchema).handler(async ({ input }) => {
  return customerService.list(input);
});

export const get = authRequired.input(idInputSchema).handler(async ({ input }) => {
  return unwrap(await customerService.getById(input.id));
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  return unwrap(await customerService.update(id, updateData));
});

export const remove = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await customerService.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

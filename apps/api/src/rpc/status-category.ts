import { z } from "zod";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { statusCategory } from "@rw/services/facility/index";
import { throwServiceError, unwrap } from "./errors.js";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
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

export const create = authRequired.input(createInputSchema).handler(async ({ input }) => {
  const result = await statusCategory.create(input);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const list = userOrDisplayRequired.input(listInputSchema).handler(async ({ input }) => {
  return statusCategory.list(input);
});

export const get = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await statusCategory.getById(input.id);
  return unwrap(result, { notFoundMessage: "Status category not found" });
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  const result = await statusCategory.update(id, updateData);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const remove = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await statusCategory.remove(input.id);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

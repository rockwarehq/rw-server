import { z } from "zod";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
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
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  isPlannedDown: z.boolean().optional(),
  categoryId: z.uuid().nullable().optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Procedures
// ============================================================================

export const create = authRequired.input(createInputSchema).handler(async ({ input }) => {
  const result = await statusReason.create(input);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const list = userOrDisplayRequired.input(listInputSchema).handler(async ({ input }) => {
  return statusReason.list(input);
});

export const get = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await statusReason.getById(input.id);
  return unwrap(result, { notFoundMessage: "Status reason not found" });
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  const result = await statusReason.update(id, updateData);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const remove = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await statusReason.remove(input.id);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

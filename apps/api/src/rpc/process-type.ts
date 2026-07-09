import { z } from "zod";
import { authRequired } from "./middleware.js";
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

export const create = authRequired.input(createInputSchema).handler(async ({ input }) => {
  return unwrap(await processType.create(input));
});

export const list = authRequired.input(listInputSchema).handler(async ({ input }) => {
  return processType.list(input);
});

export const get = authRequired.input(idInputSchema).handler(async ({ input }) => {
  return unwrap(await processType.getById(input.id), { notFoundMessage: "Process type not found" });
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  return unwrap(await processType.update(id, updateData));
});

export const remove = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await processType.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

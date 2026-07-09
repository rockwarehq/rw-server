import { z } from "zod";
import { authRequired } from "./middleware.js";
import { role } from "../services/employee/index.js";
import { throwServiceError } from "./errors.js";

// ============================================================================
// Input Schemas
// ============================================================================

const listInputSchema = z.object({
  siteId: z.uuid(),
});

const createInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1).max(50),
  permissions: z.array(z.string()).optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(50).optional(),
  permissions: z.array(z.string()).optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

// ============================================================================
// Procedures
// ============================================================================

export const list = authRequired.input(listInputSchema).handler(async ({ input }) => {
  const result = await role.list(input.siteId);
  return result.data;
});

export const create = authRequired.input(createInputSchema).handler(async ({ input }) => {
  const result = await role.create(input);
  return result.data;
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input }) => {
  const { id, ...data } = input;
  const result = await role.update(id, data);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const remove = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await role.remove(input.id);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

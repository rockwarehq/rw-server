import { z } from "zod";
import { userRequired } from "./middleware.js";
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

export const list = userRequired.input(listInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.siteId });

  const result = await role.list(input.siteId);
  return result.data;
});

export const create = userRequired.input(createInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.siteId });

  const result = await role.create(input);
  return result.data;
});

export const update = userRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { employeeRole: input.id });

  const { id, ...data } = input;
  const result = await role.update(id, data);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const remove = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { employeeRole: input.id });

  const result = await role.remove(input.id);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

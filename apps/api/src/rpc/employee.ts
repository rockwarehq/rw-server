import { z } from "zod";
import { authRequired } from "./middleware.js";
import { crud } from "../services/employee/index.js";
import { throwServiceError, unwrap } from "./errors.js";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  siteId: z.uuid(),
  employeeNumber: z.string().min(1).nullable().optional(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  roleId: z.uuid().optional(),
  pin: z.string().min(4).max(8).optional(),
  badgeNumber: z.string().min(1).nullable().optional(),
});

const listInputSchema = z.object({
  siteId: z.uuid(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  roleId: z.uuid().optional(),
  search: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  employeeNumber: z.string().min(1).nullable().optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  roleId: z.uuid().optional(),
  pin: z.string().min(4).max(8).optional(),
  badgeNumber: z.string().min(1).nullable().optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

// ============================================================================
// Procedures
// ============================================================================

export const create = authRequired.input(createInputSchema).handler(async ({ input }) => {
  const result = await crud.create(input);
  return result.data;
});

export const list = authRequired.input(listInputSchema).handler(async ({ input }) => {
  return crud.list(input);
});

export const get = authRequired.input(idInputSchema).handler(async ({ input }) => {
  return unwrap(await crud.getById(input.id), { notFoundMessage: "Employee not found" });
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  const result = await crud.update(id, updateData);
  // Historical mapping: a role from another workspace surfaced as NOT_FOUND
  // here (the role is invisible to the caller), not the shared FORBIDDEN default.
  if (result.error !== undefined) throwServiceError(result, { WORKSPACE_MISMATCH: "NOT_FOUND" });
  return result.data;
});

export const remove = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await crud.remove(input.id);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

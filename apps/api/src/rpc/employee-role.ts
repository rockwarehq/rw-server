import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired } from "./middleware.js";
import { role } from "../services/employee/index.js";

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
  if ("error" in result) {
    throw new ORPCError("NOT_FOUND", { message: result.error });
  }
  return result.data;
});

export const remove = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await role.remove(input.id);
  if ("error" in result) {
    const code = result.code === "CONFLICT" ? "CONFLICT" : "NOT_FOUND";
    throw new ORPCError(code, { message: result.error });
  }
  return { success: true };
});

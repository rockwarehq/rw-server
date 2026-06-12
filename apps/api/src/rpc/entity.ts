import { ORPCError } from "@orpc/server";
import { z } from "zod";
import * as entity from "@rw/services/entity/index";
import { hasPermission, type Permission } from "@rw/services/iam/index";

import { authRequired } from "./middleware.js";

const fieldTypeSchema = z.enum(["TEXT", "NUMBER", "BOOLEAN", "DATE", "TIMESTAMP", "SELECT", "JSON", "OBJECT"]);
const jsonObjectSchema = z.record(z.string(), z.unknown());

const idInputSchema = z.object({ id: z.uuid() });
const listInputSchema = z.object({
  name: z.string().optional(),
  limit: z.number().int().min(0).default(50),
  offset: z.number().int().min(0).default(0),
});

const schemaCreateInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const schemaUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
});

const fieldCreateInputSchema = z.object({
  schemaId: z.uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  type: fieldTypeSchema,
  refSchemaId: z.uuid().nullable().optional(),
  isList: z.boolean().optional(),
  required: z.boolean().optional(),
  config: jsonObjectSchema.nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const fieldUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  type: fieldTypeSchema.optional(),
  refSchemaId: z.uuid().nullable().optional(),
  isList: z.boolean().optional(),
  required: z.boolean().optional(),
  config: jsonObjectSchema.nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const fieldReorderInputSchema = z.object({
  schemaId: z.uuid(),
  fieldIds: z.array(z.uuid()),
});

const instanceCreateInputSchema = z.object({
  schemaId: z.uuid(),
  name: z.string().min(1),
  values: jsonObjectSchema.optional(),
});

const instanceListInputSchema = listInputSchema.extend({
  schemaId: z.uuid().optional(),
});

const instanceUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  values: jsonObjectSchema.optional(),
});

type AuthContext = { iam: { id: string; workspaceId?: string | null; siteId?: string | null } };

async function assertPermission(context: AuthContext, permission: Permission): Promise<string> {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  const ok = await hasPermission(context.iam.id, permission, {
    workspaceId,
    ...(context.iam.siteId ? { siteId: context.iam.siteId } : {}),
  });
  if (!ok) throw new ORPCError("FORBIDDEN", { message: `Missing permission: ${permission}` });
  return workspaceId;
}

function throwServiceError(result: { error: string; code: string }): never {
  if (result.code.includes("NOT_FOUND")) throw new ORPCError("NOT_FOUND", { message: result.error, cause: result });
  if (result.code.includes("MISMATCH")) throw new ORPCError("FORBIDDEN", { message: result.error, cause: result });
  if (result.code.includes("EXISTS")) throw new ORPCError("CONFLICT", { message: result.error, cause: result });
  throw new ORPCError("BAD_REQUEST", { message: result.error, cause: result });
}

function unwrap<T>(result: { data: T } | { error: string; code: string } | null): T {
  if (!result) throw new ORPCError("NOT_FOUND", { message: "Resource not found" });
  if ("error" in result) throwServiceError(result);
  return result.data;
}

export const schemaCreate = authRequired.input(schemaCreateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "entity:write");
  return unwrap(await entity.schemas.create(input, workspaceId));
});

export const schemaList = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "entity:read");
  return entity.schemas.list(input, workspaceId);
});

export const schemaGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "entity:read");
  return unwrap(await entity.schemas.getById(input.id, workspaceId));
});

export const schemaUpdate = authRequired.input(schemaUpdateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "entity:write");
  const { id, ...updates } = input;
  return unwrap(await entity.schemas.update(id, updates, workspaceId));
});

export const schemaDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "entity:write");
  return unwrap(await entity.schemas.remove(input.id, workspaceId));
});

export const fieldCreate = authRequired.input(fieldCreateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "entity:write");
  return unwrap(await entity.fields.create(input, workspaceId));
});

export const fieldUpdate = authRequired.input(fieldUpdateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "entity:write");
  const { id, ...updates } = input;
  return unwrap(await entity.fields.update(id, updates, workspaceId));
});

export const fieldDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "entity:write");
  return unwrap(await entity.fields.remove(input.id, workspaceId));
});

export const fieldReorder = authRequired.input(fieldReorderInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "entity:write");
  return unwrap(await entity.fields.reorder(input.schemaId, input.fieldIds, workspaceId));
});

export const instanceCreate = authRequired.input(instanceCreateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "entity:write");
  return unwrap(await entity.instances.create(input, workspaceId));
});

export const instanceList = authRequired.input(instanceListInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "entity:read");
  return entity.instances.list(input, workspaceId);
});

export const instanceGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "entity:read");
  return unwrap(await entity.instances.getById(input.id, workspaceId));
});

export const instanceUpdate = authRequired.input(instanceUpdateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "entity:write");
  const { id, ...updates } = input;
  return unwrap(await entity.instances.update(id, updates, workspaceId));
});

export const instanceDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "entity:write");
  return unwrap(await entity.instances.remove(input.id, workspaceId));
});

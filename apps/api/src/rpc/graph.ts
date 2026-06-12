import { ORPCError } from "@orpc/server";
import { z } from "zod";
import * as graph from "@rw/services/graph/index";
import { hasPermission, type Permission } from "@rw/services/iam/index";

import { authRequired } from "./middleware.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const idInputSchema = z.object({ id: z.uuid() });

const nodeCreateInputSchema = z.object({
  name: z.string().min(1),
  schemaId: z.uuid().optional(),
  objectInstanceId: z.uuid().optional(),
  materializeFields: z.boolean().optional(),
});

const nodeListInputSchema = z.object({
  schemaId: z.uuid().optional(),
  objectInstanceId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().int().min(0).default(50),
  offset: z.number().int().min(0).default(0),
});

const nodeUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  schemaId: z.uuid().nullable().optional(),
  objectInstanceId: z.uuid().nullable().optional(),
});

const propertyCreateInputSchema = z.object({
  nodeId: z.uuid(),
  name: z.string().min(1).optional(),
  schemaFieldId: z.uuid().nullable().optional(),
  resolverType: z.string().min(1).optional(),
  resolver: jsonObjectSchema.optional(),
  sampleRateMs: z.number().int().positive().nullable().optional(),
});

const propertyUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  schemaFieldId: z.uuid().nullable().optional(),
  resolverType: z.string().min(1).optional(),
  resolver: jsonObjectSchema.optional(),
  sampleRateMs: z.number().int().positive().nullable().optional(),
});

const propertyValidateInputSchema = propertyCreateInputSchema.extend({
  id: z.uuid().optional(),
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
  if (result.code.includes("EXISTS") || result.code === "GRAPH_CYCLE") {
    throw new ORPCError("CONFLICT", { message: result.error, cause: result });
  }
  throw new ORPCError("BAD_REQUEST", { message: result.error, cause: result });
}

function unwrap<T>(result: { data: T } | { error: string; code: string } | null): T {
  if (!result) throw new ORPCError("NOT_FOUND", { message: "Resource not found" });
  if ("error" in result) throwServiceError(result);
  return result.data;
}

export const nodeCreate = authRequired.input(nodeCreateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "graph:write");
  return unwrap(await graph.nodes.create(input, workspaceId));
});

export const nodeList = authRequired.input(nodeListInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "graph:read");
  return graph.nodes.list(input, workspaceId);
});

export const nodeGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "graph:read");
  return unwrap(await graph.nodes.getById(input.id, workspaceId));
});

export const nodeUpdate = authRequired.input(nodeUpdateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "graph:write");
  const { id, ...updates } = input;
  return unwrap(await graph.nodes.update(id, updates, workspaceId));
});

export const nodeDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "graph:write");
  return unwrap(await graph.nodes.remove(input.id, workspaceId));
});

export const propertyCreate = authRequired.input(propertyCreateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "graph:write");
  return unwrap(await graph.properties.create(input, workspaceId));
});

export const propertyUpdate = authRequired.input(propertyUpdateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "graph:write");
  const { id, ...updates } = input;
  return unwrap(await graph.properties.update(id, updates, workspaceId));
});

export const propertyDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "graph:write");
  return unwrap(await graph.properties.remove(input.id, workspaceId));
});

export const propertyDependents = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "graph:read");
  return unwrap(await graph.properties.dependents(input.id, workspaceId));
});

export const propertyValidate = authRequired.input(propertyValidateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = await assertPermission(context, "graph:write");
  return unwrap(await graph.properties.validate(input, workspaceId));
});

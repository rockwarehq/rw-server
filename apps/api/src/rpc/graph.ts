import { ORPCError } from "@orpc/server";
import { z } from "zod";
import * as graph from "@rw/services/graph/index";
import { hasPermission, type Permission } from "@rw/services/iam/index";
import type { GraphScope } from "@rw/services/graph/types";

import { authRequired } from "./middleware.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const idInputSchema = z.object({ id: z.uuid() });

const nodeCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  schemaId: z.uuid().optional(),
  documentId: z.uuid().optional(),
  recordId: z.uuid().optional(),
  materializeFields: z.boolean().optional(),
});

const nodeListInputSchema = z.object({
  siteId: z.uuid(),
  schemaId: z.uuid().optional(),
  documentId: z.uuid().optional(),
  recordId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().int().min(0).default(50),
  offset: z.number().int().min(0).default(0),
});

const nodeUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  schemaId: z.uuid().nullable().optional(),
  documentId: z.uuid().nullable().optional(),
  recordId: z.uuid().nullable().optional(),
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

const propertyListInputSchema = z
  .object({
    siteId: z.uuid().optional(),
    nodeId: z.uuid().optional(),
    name: z.string().optional(),
    resolverType: z.string().min(1).optional(),
    limit: z.number().int().min(0).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .refine((input) => Boolean(input.siteId || input.nodeId), {
    message: "siteId or nodeId is required",
  });

const propertyValidateInputSchema = propertyCreateInputSchema.extend({
  id: z.uuid().optional(),
});

const hookCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  condition: jsonObjectSchema,
  eventType: z.string().min(1),
  eventVersion: z.string().min(1).optional(),
  eventPayload: jsonObjectSchema.optional(),
  eventContext: jsonObjectSchema.optional(),
});

const hookUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  condition: jsonObjectSchema.optional(),
  eventType: z.string().min(1).optional(),
  eventVersion: z.string().min(1).optional(),
  eventPayload: jsonObjectSchema.optional(),
  eventContext: jsonObjectSchema.optional(),
});

const hookListInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  eventType: z.string().min(1).optional(),
  limit: z.number().int().min(0).default(50),
  offset: z.number().int().min(0).default(0),
});

type AuthContext = {
  iam: { id: string; workspaceId?: string | null; siteId?: string | null };
};

function requireWorkspaceId(context: AuthContext): string {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId)
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  return workspaceId;
}

async function assertSitePermission(
  context: AuthContext,
  permission: Permission,
  siteId: string,
): Promise<GraphScope> {
  const workspaceId = requireWorkspaceId(context);
  const ok = await hasPermission(context.iam.id, permission, {
    workspaceId,
    siteId,
  });
  if (!ok)
    throw new ORPCError("FORBIDDEN", {
      message: `Missing permission: ${permission}`,
    });
  return { workspaceId, siteId };
}

function throwServiceError(result: { error: string; code: string }): never {
  if (result.code.includes("NOT_FOUND"))
    throw new ORPCError("NOT_FOUND", { message: result.error, cause: result });
  if (result.code.includes("MISMATCH"))
    throw new ORPCError("FORBIDDEN", { message: result.error, cause: result });
  if (
    result.code.includes("EXISTS") ||
    result.code.includes("HAS_") ||
    result.code === "GRAPH_CYCLE"
  ) {
    throw new ORPCError("CONFLICT", { message: result.error, cause: result });
  }
  throw new ORPCError("BAD_REQUEST", { message: result.error, cause: result });
}

function unwrap<T>(
  result: { data: T } | { error: string; code: string } | null,
): T {
  if (!result)
    throw new ORPCError("NOT_FOUND", { message: "Resource not found" });
  if ("error" in result) throwServiceError(result);
  return result.data;
}

async function assertNodePermission(
  context: AuthContext,
  permission: Permission,
  nodeId: string,
): Promise<GraphScope> {
  const workspaceId = requireWorkspaceId(context);
  const siteId = unwrap(await graph.nodes.getSiteId(nodeId, workspaceId));
  return assertSitePermission(context, permission, siteId);
}

async function assertPropertyPermission(
  context: AuthContext,
  permission: Permission,
  propertyId: string,
): Promise<GraphScope> {
  const workspaceId = requireWorkspaceId(context);
  const siteId = unwrap(
    await graph.properties.getSiteId(propertyId, workspaceId),
  );
  return assertSitePermission(context, permission, siteId);
}

async function assertHookPermission(
  context: AuthContext,
  permission: Permission,
  hookId: string,
): Promise<GraphScope> {
  const workspaceId = requireWorkspaceId(context);
  const siteId = unwrap(await graph.hooks.getSiteId(hookId, workspaceId));
  return assertSitePermission(context, permission, siteId);
}

export const nodeCreate = authRequired
  .input(nodeCreateInputSchema)
  .handler(async ({ input, context }) => {
    const { siteId, ...nodeInput } = input;
    const scope = await assertSitePermission(context, "graph:write", siteId);
    console.log("and how about now --------");
    return unwrap(await graph.nodes.create(nodeInput, scope));
  });

export const nodeList = authRequired
  .input(nodeListInputSchema)
  .handler(async ({ input, context }) => {
    const { siteId, ...filter } = input;
    const scope = await assertSitePermission(context, "graph:read", siteId);
    return graph.nodes.list(filter, scope);
  });

export const nodeGet = authRequired
  .input(idInputSchema)
  .handler(async ({ input, context }) => {
    const scope = await assertNodePermission(context, "graph:read", input.id);
    return unwrap(await graph.nodes.getById(input.id, scope));
  });

export const nodeUpdate = authRequired
  .input(nodeUpdateInputSchema)
  .handler(async ({ input, context }) => {
    const { id, ...updates } = input;
    const scope = await assertNodePermission(context, "graph:write", id);
    return unwrap(await graph.nodes.update(id, updates, scope));
  });

export const nodeDelete = authRequired
  .input(idInputSchema)
  .handler(async ({ input, context }) => {
    const scope = await assertNodePermission(context, "graph:write", input.id);
    return unwrap(await graph.nodes.remove(input.id, scope));
  });

export const propertyCreate = authRequired
  .input(propertyCreateInputSchema)
  .handler(async ({ input, context }) => {
    const scope = await assertNodePermission(
      context,
      "graph:write",
      input.nodeId,
    );
    return unwrap(await graph.properties.create(input, scope));
  });

export const propertyList = authRequired
  .input(propertyListInputSchema)
  .handler(async ({ input, context }) => {
    if (input.nodeId) {
      const scope = await assertNodePermission(
        context,
        "graph:read",
        input.nodeId,
      );
      if (input.siteId && input.siteId !== scope.siteId) {
        throw new ORPCError("BAD_REQUEST", {
          message: "siteId must match node site",
        });
      }
      const { siteId: _siteId, ...filter } = input;
      return graph.properties.list(filter, scope);
    }

    const siteId = input.siteId;
    if (!siteId)
      throw new ORPCError("BAD_REQUEST", {
        message: "siteId or nodeId is required",
      });
    const scope = await assertSitePermission(context, "graph:read", siteId);
    const { siteId: _siteId, ...filter } = input;
    return graph.properties.list(filter, scope);
  });

export const propertyGet = authRequired
  .input(idInputSchema)
  .handler(async ({ input, context }) => {
    const scope = await assertPropertyPermission(
      context,
      "graph:read",
      input.id,
    );
    return unwrap(await graph.properties.getById(input.id, scope));
  });

export const propertyUpdate = authRequired
  .input(propertyUpdateInputSchema)
  .handler(async ({ input, context }) => {
    const { id, ...updates } = input;
    const scope = await assertPropertyPermission(context, "graph:write", id);
    return unwrap(await graph.properties.update(id, updates, scope));
  });

export const propertyDelete = authRequired
  .input(idInputSchema)
  .handler(async ({ input, context }) => {
    const scope = await assertPropertyPermission(
      context,
      "graph:write",
      input.id,
    );
    return unwrap(await graph.properties.remove(input.id, scope));
  });

export const propertyDependents = authRequired
  .input(idInputSchema)
  .handler(async ({ input, context }) => {
    const scope = await assertPropertyPermission(
      context,
      "graph:read",
      input.id,
    );
    return unwrap(await graph.properties.dependents(input.id, scope));
  });

export const propertyValidate = authRequired
  .input(propertyValidateInputSchema)
  .handler(async ({ input, context }) => {
    const scope = await assertNodePermission(
      context,
      "graph:write",
      input.nodeId,
    );
    return unwrap(await graph.properties.validate(input, scope));
  });

export const hookCreate = authRequired
  .input(hookCreateInputSchema)
  .handler(async ({ input, context }) => {
    const { siteId, ...hookInput } = input;
    const scope = await assertSitePermission(context, "graph:write", siteId);
    return unwrap(await graph.hooks.create(hookInput, scope));
  });

export const hookList = authRequired
  .input(hookListInputSchema)
  .handler(async ({ input, context }) => {
    const { siteId, ...filter } = input;
    const scope = await assertSitePermission(context, "graph:read", siteId);
    return graph.hooks.list(filter, scope);
  });

export const hookGet = authRequired
  .input(idInputSchema)
  .handler(async ({ input, context }) => {
    const scope = await assertHookPermission(context, "graph:read", input.id);
    return unwrap(await graph.hooks.getById(input.id, scope));
  });

export const hookUpdate = authRequired
  .input(hookUpdateInputSchema)
  .handler(async ({ input, context }) => {
    const { id, ...updates } = input;
    const scope = await assertHookPermission(context, "graph:write", id);
    return unwrap(await graph.hooks.update(id, updates, scope));
  });

export const hookDelete = authRequired
  .input(idInputSchema)
  .handler(async ({ input, context }) => {
    const scope = await assertHookPermission(context, "graph:write", input.id);
    return unwrap(await graph.hooks.remove(input.id, scope));
  });

export const hookEventCatalog = authRequired.handler(async () => graph.hooks.eventCatalog());

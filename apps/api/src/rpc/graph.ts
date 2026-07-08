import { ORPCError } from "@orpc/server";
import { GRAPH_TYPE_INPUT_VALUE_TYPES, GRAPH_TYPE_VALUE_TYPES } from "@rw/livestore/catalog/graph-types";
import { z } from "zod";
import * as graph from "@rw/livestore/graph/index";
import { hasPermission, type Permission } from "@rw/services/iam/index";
import type { GraphScope } from "@rw/livestore/graph/types";
import { Principal } from "../services/auth/index.js";

import { authRequired, userOrDisplayRequired } from "./middleware.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const idInputSchema = z.object({ id: z.uuid() });
const siteInputSchema = z.object({ siteId: z.uuid() });

const nodeCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  typeRef: z.string().min(1).nullable().optional(),
  typeContext: jsonObjectSchema.optional(),
  materializeTypeFields: z.boolean().optional(),
});

const nodeListInputSchema = z.object({
  siteId: z.uuid(),
  typeRef: z.string().min(1).optional(),
  name: z.string().optional(),
  limit: z.number().int().min(0).default(50),
  offset: z.number().int().min(0).default(0),
});

const nodeQueryInputSchema = nodeListInputSchema.extend({
  facets: jsonObjectSchema.optional(),
  properties: z.array(z.string().min(1)).optional(),
});

const nodeUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  typeRef: z.string().min(1).nullable().optional(),
  typeContext: jsonObjectSchema.nullable().optional(),
});

const propertyCreateInputSchema = z.object({
  nodeId: z.uuid(),
  name: z.string().min(1),
  typeFieldKey: z.string().min(1).nullable().optional(),
  resolverType: z.string().min(1),
  resolver: jsonObjectSchema,
  sampleRateMs: z.number().int().positive().nullable().optional(),
});

const propertyUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  typeFieldKey: z.string().min(1).nullable().optional(),
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
  .refine((input) => Boolean(input.siteId || input.nodeId), { message: "siteId or nodeId is required" });

const propertyValidateInputSchema = propertyCreateInputSchema.extend({ id: z.uuid().optional() });

const graphTypeInputInputSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().nullable().optional(),
  valueType: z.enum(GRAPH_TYPE_INPUT_VALUE_TYPES),
  entityKey: z.string().min(1).nullable().optional(),
  required: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const graphTypeFacetInputSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().nullable().optional(),
  valueType: z.enum(GRAPH_TYPE_VALUE_TYPES).nullable().optional(),
  required: z.boolean().optional(),
  resolverType: z.string().min(1),
  resolver: jsonObjectSchema,
  sortOrder: z.number().int().optional(),
});

const graphTypeFieldInputSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().nullable().optional(),
  valueType: z.enum(GRAPH_TYPE_VALUE_TYPES),
  required: z.boolean().optional(),
  resolverType: z.string().min(1),
  resolver: jsonObjectSchema,
  sampleRateMs: z.number().int().positive().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const typeCreateInputSchema = z.object({
  siteId: z.uuid(),
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().nullable().optional(),
  inputs: z.array(graphTypeInputInputSchema).optional(),
  facets: z.array(graphTypeFacetInputSchema).optional(),
  fields: z.array(graphTypeFieldInputSchema).optional(),
});

const typeListInputSchema = z.object({
  siteId: z.uuid(),
  key: z.string().min(1).optional(),
  label: z.string().optional(),
  limit: z.number().int().min(0).default(50),
  offset: z.number().int().min(0).default(0),
});

const typeUpdateInputSchema = z.object({
  id: z.uuid(),
  key: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
});

const typeInputCreateInputSchema = graphTypeInputInputSchema.extend({ typeId: z.uuid() });

const typeInputUpdateInputSchema = graphTypeInputInputSchema.partial().extend({ id: z.uuid() });

const typeFacetCreateInputSchema = graphTypeFacetInputSchema.extend({ typeId: z.uuid() });

const typeFacetUpdateInputSchema = graphTypeFacetInputSchema.partial().extend({ id: z.uuid() });

const typeFieldCreateInputSchema = graphTypeFieldInputSchema.extend({ typeId: z.uuid() });

const typeFieldUpdateInputSchema = graphTypeFieldInputSchema.partial().extend({ id: z.uuid() });

const hookCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  condition: jsonObjectSchema,
  eventNamespace: z.string().min(1),
  eventName: z.string().min(1),
  eventVersion: z.string().min(1).optional(),
  eventPayload: jsonObjectSchema.optional(),
  eventContext: jsonObjectSchema.optional(),
});

const hookUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  condition: jsonObjectSchema.optional(),
  eventNamespace: z.string().min(1).optional(),
  eventName: z.string().min(1).optional(),
  eventVersion: z.string().min(1).optional(),
  eventPayload: jsonObjectSchema.optional(),
  eventContext: jsonObjectSchema.optional(),
});

const hookListInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  eventNamespace: z.string().min(1).optional(),
  eventName: z.string().min(1).optional(),
  limit: z.number().int().min(0).default(50),
  offset: z.number().int().min(0).default(0),
});

type AuthContext = {
  iam: { principal?: string; id?: string; workspaceId?: string | null; siteId?: string | null };
};

function requireWorkspaceId(context: AuthContext): string {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  return workspaceId;
}

async function assertSitePermission(context: AuthContext, permission: Permission, siteId: string): Promise<GraphScope> {
  const workspaceId = requireWorkspaceId(context);
  const userId = context.iam.id;
  if (!userId) throw new ORPCError("UNAUTHORIZED", { message: "Authentication required" });
  const ok = await hasPermission(userId, permission, { workspaceId, siteId });
  if (!ok) throw new ORPCError("FORBIDDEN", { message: `Missing permission: ${permission}` });
  return { workspaceId, siteId };
}

async function assertSiteReadAccess(context: AuthContext, siteId: string): Promise<GraphScope> {
  if (context.iam.principal === Principal.DISPLAY) {
    const workspaceId = requireWorkspaceId(context);
    if (context.iam.siteId !== siteId) {
      throw new ORPCError("FORBIDDEN", { message: "Display can only access graph for its site" });
    }
    return { workspaceId, siteId };
  }

  return assertSitePermission(context, "graph:read", siteId);
}

function throwServiceError(result: { error: string; code: string }): never {
  if (result.code.includes("NOT_FOUND")) throw new ORPCError("NOT_FOUND", { message: result.error, cause: result });
  if (result.code.includes("MISMATCH")) throw new ORPCError("FORBIDDEN", { message: result.error, cause: result });
  if (result.code.includes("EXISTS") || result.code.includes("HAS_") || result.code === "GRAPH_CYCLE") {
    throw new ORPCError("CONFLICT", { message: result.error, cause: result });
  }
  throw new ORPCError("BAD_REQUEST", { message: result.error, cause: result });
}

function unwrap<T>(result: { data: T } | { error: string; code: string } | null): T {
  if (!result) throw new ORPCError("NOT_FOUND", { message: "Resource not found" });
  if ("error" in result) throwServiceError(result);
  return result.data;
}

async function assertNodePermission(context: AuthContext, permission: Permission, nodeId: string): Promise<GraphScope> {
  const workspaceId = requireWorkspaceId(context);
  const siteId = unwrap(await graph.nodes.getSiteId(nodeId, workspaceId));
  return assertSitePermission(context, permission, siteId);
}

async function assertNodeReadAccess(context: AuthContext, nodeId: string): Promise<GraphScope> {
  const workspaceId = requireWorkspaceId(context);
  const siteId = unwrap(await graph.nodes.getSiteId(nodeId, workspaceId));
  return assertSiteReadAccess(context, siteId);
}

async function assertPropertyPermission(
  context: AuthContext,
  permission: Permission,
  propertyId: string,
): Promise<GraphScope> {
  const workspaceId = requireWorkspaceId(context);
  const siteId = unwrap(await graph.properties.getSiteId(propertyId, workspaceId));
  return assertSitePermission(context, permission, siteId);
}

async function assertPropertyReadAccess(context: AuthContext, propertyId: string): Promise<GraphScope> {
  const workspaceId = requireWorkspaceId(context);
  const siteId = unwrap(await graph.properties.getSiteId(propertyId, workspaceId));
  return assertSiteReadAccess(context, siteId);
}

async function assertHookPermission(context: AuthContext, permission: Permission, hookId: string): Promise<GraphScope> {
  const workspaceId = requireWorkspaceId(context);
  const siteId = unwrap(await graph.hooks.getSiteId(hookId, workspaceId));
  return assertSitePermission(context, permission, siteId);
}

async function assertTypePermission(context: AuthContext, permission: Permission, typeId: string): Promise<GraphScope> {
  const workspaceId = requireWorkspaceId(context);
  const siteId = unwrap(await graph.nodeTypes.getSiteId(typeId, workspaceId));
  return assertSitePermission(context, permission, siteId);
}

async function assertTypeReadAccess(context: AuthContext, typeId: string): Promise<GraphScope> {
  const workspaceId = requireWorkspaceId(context);
  const siteId = unwrap(await graph.nodeTypes.getSiteId(typeId, workspaceId));
  return assertSiteReadAccess(context, siteId);
}

async function assertTypeFieldPermission(
  context: AuthContext,
  permission: Permission,
  fieldId: string,
): Promise<GraphScope> {
  const workspaceId = requireWorkspaceId(context);
  const siteId = unwrap(await graph.nodeTypes.getFieldSiteId(fieldId, workspaceId));
  return assertSitePermission(context, permission, siteId);
}

async function assertTypeInputPermission(
  context: AuthContext,
  permission: Permission,
  inputId: string,
): Promise<GraphScope> {
  const workspaceId = requireWorkspaceId(context);
  const siteId = unwrap(await graph.nodeTypes.getInputSiteId(inputId, workspaceId));
  return assertSitePermission(context, permission, siteId);
}

async function assertTypeFacetPermission(
  context: AuthContext,
  permission: Permission,
  facetId: string,
): Promise<GraphScope> {
  const workspaceId = requireWorkspaceId(context);
  const siteId = unwrap(await graph.nodeTypes.getFacetSiteId(facetId, workspaceId));
  return assertSitePermission(context, permission, siteId);
}

export const nodeCreate = authRequired.input(nodeCreateInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...nodeInput } = input;
  const scope = await assertSitePermission(context, "graph:write", siteId);
  return unwrap(await graph.nodes.create(nodeInput, scope));
});

export const nodeList = userOrDisplayRequired.input(nodeListInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...filter } = input;
  const scope = await assertSiteReadAccess(context, siteId);
  return graph.nodes.list(filter, scope);
});

export const nodeQuery = userOrDisplayRequired.input(nodeQueryInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...filter } = input;
  const scope = await assertSiteReadAccess(context, siteId);
  return graph.nodes.query(filter, scope);
});

export const nodeGet = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertNodeReadAccess(context, input.id);
  return unwrap(await graph.nodes.getById(input.id, scope));
});

export const nodeUpdate = authRequired.input(nodeUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updates } = input;
  const scope = await assertNodePermission(context, "graph:write", id);
  return unwrap(await graph.nodes.update(id, updates, scope));
});

export const nodeDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertNodePermission(context, "graph:write", input.id);
  return unwrap(await graph.nodes.remove(input.id, scope));
});

export const typeCatalog = userOrDisplayRequired.input(siteInputSchema).handler(async ({ input, context }) => {
  const scope = await assertSiteReadAccess(context, input.siteId);
  return unwrap(await graph.nodeTypes.catalog(scope));
});

export const typeCreate = authRequired.input(typeCreateInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...typeInput } = input;
  const scope = await assertSitePermission(context, "graph:write", siteId);
  return unwrap(await graph.nodeTypes.create(typeInput, scope));
});

export const typeList = userOrDisplayRequired.input(typeListInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...filter } = input;
  const scope = await assertSiteReadAccess(context, siteId);
  return graph.nodeTypes.list(filter, scope);
});

export const typeGet = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertTypeReadAccess(context, input.id);
  return unwrap(await graph.nodeTypes.getById(input.id, scope));
});

export const typeUpdate = authRequired.input(typeUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updates } = input;
  const scope = await assertTypePermission(context, "graph:write", id);
  return unwrap(await graph.nodeTypes.update(id, updates, scope));
});

export const typeDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertTypePermission(context, "graph:write", input.id);
  return unwrap(await graph.nodeTypes.remove(input.id, scope));
});

export const typeInputCreate = authRequired.input(typeInputCreateInputSchema).handler(async ({ input, context }) => {
  const scope = await assertTypePermission(context, "graph:write", input.typeId);
  return unwrap(await graph.nodeTypes.createInput(input, scope));
});

export const typeInputUpdate = authRequired.input(typeInputUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updates } = input;
  const scope = await assertTypeInputPermission(context, "graph:write", id);
  return unwrap(await graph.nodeTypes.updateInput(id, updates, scope));
});

export const typeInputDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertTypeInputPermission(context, "graph:write", input.id);
  return unwrap(await graph.nodeTypes.removeInput(input.id, scope));
});

export const typeFacetCreate = authRequired.input(typeFacetCreateInputSchema).handler(async ({ input, context }) => {
  const scope = await assertTypePermission(context, "graph:write", input.typeId);
  return unwrap(await graph.nodeTypes.createFacet(input, scope));
});

export const typeFacetUpdate = authRequired.input(typeFacetUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updates } = input;
  const scope = await assertTypeFacetPermission(context, "graph:write", id);
  return unwrap(await graph.nodeTypes.updateFacet(id, updates, scope));
});

export const typeFacetDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertTypeFacetPermission(context, "graph:write", input.id);
  return unwrap(await graph.nodeTypes.removeFacet(input.id, scope));
});

export const typeFieldCreate = authRequired.input(typeFieldCreateInputSchema).handler(async ({ input, context }) => {
  const scope = await assertTypePermission(context, "graph:write", input.typeId);
  return unwrap(await graph.nodeTypes.createField(input, scope));
});

export const typeFieldUpdate = authRequired.input(typeFieldUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updates } = input;
  const scope = await assertTypeFieldPermission(context, "graph:write", id);
  return unwrap(await graph.nodeTypes.updateField(id, updates, scope));
});

export const typeFieldDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertTypeFieldPermission(context, "graph:write", input.id);
  return unwrap(await graph.nodeTypes.removeField(input.id, scope));
});

export const propertyCreate = authRequired.input(propertyCreateInputSchema).handler(async ({ input, context }) => {
  const scope = await assertNodePermission(context, "graph:write", input.nodeId);
  return unwrap(await graph.properties.create(input, scope));
});

export const propertyList = userOrDisplayRequired.input(propertyListInputSchema).handler(async ({ input, context }) => {
  if (input.nodeId) {
    const scope = await assertNodeReadAccess(context, input.nodeId);
    if (input.siteId && input.siteId !== scope.siteId)
      throw new ORPCError("BAD_REQUEST", { message: "siteId must match node site" });
    const { siteId: _siteId, ...filter } = input;
    return graph.properties.list(filter, scope);
  }

  const siteId = input.siteId;
  if (!siteId) throw new ORPCError("BAD_REQUEST", { message: "siteId or nodeId is required" });
  const scope = await assertSiteReadAccess(context, siteId);
  const { siteId: _siteId, ...filter } = input;
  return graph.properties.list(filter, scope);
});

export const propertyGet = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPropertyReadAccess(context, input.id);
  return unwrap(await graph.properties.getById(input.id, scope));
});

export const propertyUpdate = authRequired.input(propertyUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updates } = input;
  const scope = await assertPropertyPermission(context, "graph:write", id);
  return unwrap(await graph.properties.update(id, updates, scope));
});

export const propertyDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPropertyPermission(context, "graph:write", input.id);
  return unwrap(await graph.properties.remove(input.id, scope));
});

export const propertyDependents = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPropertyReadAccess(context, input.id);
  return unwrap(await graph.properties.dependents(input.id, scope));
});

export const propertyValidate = authRequired.input(propertyValidateInputSchema).handler(async ({ input, context }) => {
  const scope = await assertNodePermission(context, "graph:write", input.nodeId);
  return unwrap(await graph.properties.validate(input, scope));
});

export const hookCreate = authRequired.input(hookCreateInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...hookInput } = input;
  const scope = await assertSitePermission(context, "graph:write", siteId);
  return unwrap(await graph.hooks.create(hookInput, scope));
});

export const hookList = authRequired.input(hookListInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...filter } = input;
  const scope = await assertSitePermission(context, "graph:read", siteId);
  return graph.hooks.list(filter, scope);
});

export const hookGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertHookPermission(context, "graph:read", input.id);
  return unwrap(await graph.hooks.getById(input.id, scope));
});

export const hookUpdate = authRequired.input(hookUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updates } = input;
  const scope = await assertHookPermission(context, "graph:write", id);
  return unwrap(await graph.hooks.update(id, updates, scope));
});

export const hookDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertHookPermission(context, "graph:write", input.id);
  return unwrap(await graph.hooks.remove(input.id, scope));
});

export const hookEventCatalog = authRequired.handler(async () => graph.hooks.eventCatalog());

import { ORPCError } from "@orpc/server";
import { isDeepStrictEqual } from "node:util";
import { type CodeOverrides, unwrap as unwrapService } from "./errors.js";
import { GRAPH_TYPE_INPUT_VALUE_TYPES, GRAPH_TYPE_VALUE_TYPES } from "@rw/livestore/catalog/graph-types";
import { buildLivestoreCapabilityManifest } from "@rw/livestore/catalog/manifest";
import { z } from "zod";
import * as graph from "@rw/livestore/graph/index";
import { authorize as authorizePolicy, type ScopeRef, type SiteGrant, type PolicyDenial } from "@rw/auth/iam/policy";
import { resolveSiteRef } from "@rw/auth/iam/policy-resolvers";
import type { AppIAMContext, IAMContext } from "@rw/auth/context";
import { PublishedGraphAccess, publishedReadScope } from "@rw/livestore/graph/read-scope";
import prisma from "@rw/db";
import { grant } from "./authz.js";
import { readGraphValues } from "../nats/graph-values.js";

import { authRequired, graphReadRequired } from "./middleware.js";

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
  // Client-generated UUID so planned batches can pre-reference the property
  // (see graph.introspect.plan); server-assigned when omitted.
  id: z.uuid().optional(),
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

// Historical mapping in this router: scope/resolver mismatches are FORBIDDEN
// (the shared default is CONFLICT / BAD_REQUEST). Pinned for rpc-client
// back-compat.
const GRAPH_OVERRIDES: CodeOverrides = {
  SITE_MISMATCH: "FORBIDDEN",
  ENTITY_SITE_MISMATCH: "FORBIDDEN",
  RESOLVER_TYPE_MISMATCH: "FORBIDDEN",
};

function unwrap<T>(result: { data: T } | { error: string; code: string } | null): T {
  return unwrapService(result, { overrides: GRAPH_OVERRIDES });
}

// Definition endpoints use configuration permission. APP/DISPLAY retain their
// existing site-bound published read contract through the transport middleware.
async function authorize(
  iam: IAMContext,
  check: { permission: "configuration:read" | "configuration:write"; scope: ScopeRef },
) {
  if (iam.principal === "APP" && check.permission === "configuration:read") return authorizeGraphApp(iam, check.scope);
  const result = await authorizePolicy(iam, check);
  if (!result.ok) return result;
  if (!result.siteId) throw new ORPCError("FORBIDDEN");
  return { ...result, siteId: result.siteId };
}

// APP scopes are an explicit, read-only graph contract, outside customer IAM.
async function authorizeGraphApp(iam: IAMContext, ref: ScopeRef): Promise<SiteGrant | PolicyDenial> {
  const app = iam as AppIAMContext;
  if (
    !app.validToken ||
    app.principal !== "APP" ||
    !app.workspaceId ||
    !app.siteId ||
    !app.scopes?.includes("graph:read")
  ) {
    return { ok: false, code: "FORBIDDEN", message: "App token requires graph:read" };
  }
  if (ref.kind === "workspace" || ref.kind === "anySite") {
    return { ok: false, code: "FORBIDDEN", message: "App tokens require a site-bound graph resource" };
  }
  const target = ref.kind === "site" ? ref : await resolveSiteRef(ref);
  if (!target) return { ok: false, code: "NOT_FOUND", message: "Graph resource not found" };
  if (target.siteId !== app.siteId)
    return { ok: false, code: "FORBIDDEN", message: "Token not authorized for this site" };
  return { ok: true, workspaceId: app.workspaceId, siteId: app.siteId };
}

async function publishedAccess(iam: IAMContext, siteId: string) {
  if (iam.principal === "APP") {
    return { scope: grant(await authorizeGraphApp(iam, { kind: "site", siteId })), access: null };
  }
  if (iam.principal !== "USER") {
    const scope = grant(await authorizePolicy(iam, { permission: "production:read", scope: { kind: "site", siteId } }));
    return { scope, access: null };
  }
  const scope = await publishedReadScope(iam, siteId);
  if (!scope) throw new ORPCError("FORBIDDEN");
  return { scope, access: new PublishedGraphAccess(scope) };
}

async function nodeSite(id: string) {
  const node = await prisma.graphNode.findUnique({ where: { id }, select: { siteId: true } });
  if (!node) throw new ORPCError("NOT_FOUND");
  return node.siteId;
}

async function propertySite(id: string) {
  const property = await prisma.graphProperty.findUnique({
    where: { id },
    select: { node: { select: { siteId: true } } },
  });
  if (!property) throw new ORPCError("NOT_FOUND");
  return property.node.siteId;
}

type PublishedNode = {
  id: string;
  siteId: string;
  typeRef?: string | null;
  typeContext?: unknown;
  facets?: unknown;
  properties: { id: string }[];
};

async function publishedNodes(iam: IAMContext, siteId: string, filter: z.infer<typeof nodeQueryInputSchema>) {
  const { scope, access } = await publishedAccess(iam, siteId);
  if (!access) return graph.nodes.query(filter, scope);
  // Editors may query definition metadata, but filtering raw materialized facets
  // would reveal denied native values through counts. Shape first, then filter.
  if (filter.facets && Object.keys(filter.facets).length && !access.scope.configurationRead) {
    throw new ORPCError("FORBIDDEN", { message: "Scoped graph facet queries are unsupported" });
  }
  const result = await graph.nodes.query({ ...filter, facets: undefined, limit: 0, offset: 0 }, scope);
  const data: PublishedNode[] = [];
  for (const node of result.data as PublishedNode[]) {
    const visible = await access.node(node);
    if (
      visible &&
      Object.entries(filter.facets ?? {}).every(([key, value]) =>
        isDeepStrictEqual((visible.facets as Record<string, unknown> | undefined)?.[key], value),
      )
    )
      data.push(visible);
  }
  return {
    ...result,
    total: data.length,
    limit: filter.limit,
    offset: filter.offset,
    data: filter.limit ? data.slice(filter.offset, filter.offset + filter.limit) : data.slice(filter.offset),
  };
}

export const nodeCreate = authRequired.input(nodeCreateInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...nodeInput } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "site", siteId } }),
  );
  const node = unwrap(await graph.nodes.create(nodeInput, scope)) as PublishedNode;
  const { access } = await publishedAccess(context.iam, scope.siteId);
  return access ? await access.node(node) : node;
});

export const nodeList = graphReadRequired.input(nodeListInputSchema).handler(async ({ input, context }) => {
  return publishedNodes(context.iam, input.siteId, input);
});

export const nodeQuery = graphReadRequired.input(nodeQueryInputSchema).handler(async ({ input, context }) => {
  return publishedNodes(context.iam, input.siteId, input);
});

export const nodeGet = graphReadRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const { scope, access } = await publishedAccess(context.iam, await nodeSite(input.id));
  const node = unwrap(await graph.nodes.getById(input.id, scope)) as PublishedNode;
  const visible = access ? await access.node(node) : node;
  if (!visible) throw new ORPCError("NOT_FOUND");
  return visible;
});

export const nodeUpdate = authRequired.input(nodeUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updates } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "graphNode", id: id } }),
  );
  unwrap(await graph.nodes.update(id, updates, scope));
  // Type-context updates rematerialize properties after the service captures its
  // update include. Return the saved definition, with the new resolver configs.
  const node = unwrap(await graph.nodes.getById(id, scope)) as PublishedNode;
  const { access } = await publishedAccess(context.iam, scope.siteId);
  return access ? await access.node(node) : node;
});

export const nodeDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "graphNode", id: input.id } }),
  );
  return unwrap(await graph.nodes.remove(input.id, scope));
});

export const typeCatalog = graphReadRequired.input(siteInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:read", scope: { kind: "site", siteId: input.siteId } }),
  );
  return unwrap(await graph.nodeTypes.catalog(scope));
});

export const typeCreate = authRequired.input(typeCreateInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...typeInput } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "site", siteId } }),
  );
  return unwrap(await graph.nodeTypes.create(typeInput, scope));
});

export const typeList = graphReadRequired.input(typeListInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...filter } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:read", scope: { kind: "site", siteId } }),
  );
  return graph.nodeTypes.list(filter, scope);
});

export const typeGet = graphReadRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:read", scope: { kind: "graphNodeType", id: input.id } }),
  );
  return unwrap(await graph.nodeTypes.getById(input.id, scope));
});

export const typeUpdate = authRequired.input(typeUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updates } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "graphNodeType", id: id } }),
  );
  return unwrap(await graph.nodeTypes.update(id, updates, scope));
});

export const typeDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "graphNodeType", id: input.id } }),
  );
  return unwrap(await graph.nodeTypes.remove(input.id, scope));
});

export const typeInputCreate = authRequired.input(typeInputCreateInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, {
      permission: "configuration:write",
      scope: { kind: "graphNodeType", id: input.typeId },
    }),
  );
  return unwrap(await graph.nodeTypes.createInput(input, scope));
});

export const typeInputUpdate = authRequired.input(typeInputUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updates } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "graphTypeInput", id: id } }),
  );
  return unwrap(await graph.nodeTypes.updateInput(id, updates, scope));
});

export const typeInputDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, {
      permission: "configuration:write",
      scope: { kind: "graphTypeInput", id: input.id },
    }),
  );
  return unwrap(await graph.nodeTypes.removeInput(input.id, scope));
});

export const typeFacetCreate = authRequired.input(typeFacetCreateInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, {
      permission: "configuration:write",
      scope: { kind: "graphNodeType", id: input.typeId },
    }),
  );
  return unwrap(await graph.nodeTypes.createFacet(input, scope));
});

export const typeFacetUpdate = authRequired.input(typeFacetUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updates } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "graphTypeFacet", id: id } }),
  );
  return unwrap(await graph.nodeTypes.updateFacet(id, updates, scope));
});

export const typeFacetDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, {
      permission: "configuration:write",
      scope: { kind: "graphTypeFacet", id: input.id },
    }),
  );
  return unwrap(await graph.nodeTypes.removeFacet(input.id, scope));
});

export const typeFieldCreate = authRequired.input(typeFieldCreateInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, {
      permission: "configuration:write",
      scope: { kind: "graphNodeType", id: input.typeId },
    }),
  );
  return unwrap(await graph.nodeTypes.createField(input, scope));
});

export const typeFieldUpdate = authRequired.input(typeFieldUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updates } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "graphTypeField", id: id } }),
  );
  return unwrap(await graph.nodeTypes.updateField(id, updates, scope));
});

export const typeFieldDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, {
      permission: "configuration:write",
      scope: { kind: "graphTypeField", id: input.id },
    }),
  );
  return unwrap(await graph.nodeTypes.removeField(input.id, scope));
});

export const propertyCreate = authRequired.input(propertyCreateInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "graphNode", id: input.nodeId } }),
  );
  return unwrap(await graph.properties.create(input, scope));
});

export const propertyList = graphReadRequired.input(propertyListInputSchema).handler(async ({ input, context }) => {
  const siteId = input.nodeId ? await nodeSite(input.nodeId) : input.siteId;
  if (!siteId) throw new ORPCError("BAD_REQUEST", { message: "siteId or nodeId is required" });
  if (input.siteId && input.siteId !== siteId) throw new ORPCError("BAD_REQUEST");
  const { scope, access } = await publishedAccess(context.iam, siteId);
  const { siteId: _siteId, ...filter } = input;
  if (!access) return graph.properties.list(filter, scope);
  const result = await graph.properties.list({ ...filter, limit: 0, offset: 0 }, scope);
  const data = [];
  for (const property of result.data as { id: string }[]) {
    if (access.scope.configurationRead || (await access.property(property.id)))
      data.push(await access.propertyMetadata(property));
  }
  return {
    ...result,
    total: data.length,
    limit: input.limit,
    offset: input.offset,
    data: input.limit ? data.slice(input.offset, input.offset + input.limit) : data.slice(input.offset),
  };
});

export const propertyGet = graphReadRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const { scope, access } = await publishedAccess(context.iam, await propertySite(input.id));
  if (access && !access.scope.configurationRead && !(await access.property(input.id))) throw new ORPCError("NOT_FOUND");
  const property = unwrap(await graph.properties.getById(input.id, scope));
  return access ? await access.propertyMetadata(property) : property;
});

export const propertyUpdate = authRequired.input(propertyUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updates } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "graphProperty", id: id } }),
  );
  return unwrap(await graph.properties.update(id, updates, scope));
});

export const propertyDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "graphProperty", id: input.id } }),
  );
  return unwrap(await graph.properties.remove(input.id, scope));
});

export const propertyDependents = graphReadRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:read", scope: { kind: "graphProperty", id: input.id } }),
  );
  const properties = unwrap(await graph.properties.dependents(input.id, scope));
  const { access } = await publishedAccess(context.iam, scope.siteId);
  return access ? await Promise.all(properties.map((property) => access.propertyMetadata(property))) : properties;
});

export const propertyValidate = authRequired.input(propertyValidateInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "graphNode", id: input.nodeId } }),
  );
  return unwrap(await graph.properties.validate(input, scope));
});

export const hookCreate = authRequired.input(hookCreateInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...hookInput } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "site", siteId } }),
  );
  return unwrap(await graph.hooks.create(hookInput, scope));
});

export const hookList = authRequired.input(hookListInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...filter } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:read", scope: { kind: "site", siteId } }),
  );
  return graph.hooks.list(filter, scope);
});

export const hookGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:read", scope: { kind: "graphHook", id: input.id } }),
  );
  return unwrap(await graph.hooks.getById(input.id, scope));
});

export const hookUpdate = authRequired.input(hookUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updates } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "graphHook", id: id } }),
  );
  return unwrap(await graph.hooks.update(id, updates, scope));
});

export const hookDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "graphHook", id: input.id } }),
  );
  return unwrap(await graph.hooks.remove(input.id, scope));
});

export const hookEventCatalog = authRequired.handler(async () => graph.hooks.eventCatalog());

// --- Introspection: read-only views for programmatic builders ---

// Static per deploy: resolver config schemas, hook operators, event catalog,
// limits. No tenant data, so no site assertion — any graph-read principal.
export const introspectManifest = graphReadRequired.handler(async ({ context }) => {
  if (context.iam.principal === "APP") {
    grant(await authorizeGraphApp(context.iam, { kind: "site", siteId: context.iam.siteId }));
  }
  return buildLivestoreCapabilityManifest();
});

const typeSchemaInputSchema = z.object({ siteId: z.uuid(), typeRef: z.string().min(1) });

export const introspectTypeSchema = graphReadRequired
  .input(typeSchemaInputSchema)
  .handler(async ({ input, context }) => {
    const scope = grant(
      await authorize(context.iam, { permission: "configuration:read", scope: { kind: "site", siteId: input.siteId } }),
    );
    return unwrap(await graph.introspect.typeNodeSchema(input.typeRef, scope));
  });

// Cheap freshness poll: builders compare asOf against a cached snapshot to
// decide whether to refetch.
export const introspectVersion = graphReadRequired.input(siteInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:read", scope: { kind: "site", siteId: input.siteId } }),
  );
  return graph.introspect.graphVersion(scope);
});

export const introspectSnapshot = graphReadRequired.input(siteInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:read", scope: { kind: "site", siteId: input.siteId } }),
  );
  const snapshot = unwrap(await graph.introspect.snapshot(scope));
  const { access } = await publishedAccess(context.iam, scope.siteId);
  if (!access) return snapshot;
  const nodes = await Promise.all(
    snapshot.nodes.map(async (node) => {
      const { siteId: _siteId, ...definition } = await access.definitionMetadata({ ...node, siteId: scope.siteId });
      return definition;
    }),
  );
  return { ...snapshot, nodes };
});

const introspectValuesInputSchema = z.object({
  siteId: z.uuid(),
  propertyIds: z.array(z.uuid()).min(1).max(200),
});

export const introspectValues = graphReadRequired
  .input(introspectValuesInputSchema)
  .handler(async ({ input, context }) => {
    const { scope, access } = await publishedAccess(context.iam, input.siteId);
    const ids = [];
    for (const id of input.propertyIds) if (!access || (await access.property(id))) ids.push(id);
    const properties = await graph.introspect.verifiedSiteProperties(ids, scope);
    const { available, envelopes } = await readGraphValues(properties.map((p) => p.id));
    if (access)
      for (const property of properties) {
        const envelope = envelopes.get(property.id);
        if (envelope && !(await access.property(property.id, new Set(), envelope.timestamp)))
          envelopes.delete(property.id);
      }
    const found = new Set(properties.map((p) => p.id));
    return {
      // false when the value store is unreachable — envelopes are null, not stale.
      valuesAvailable: available,
      values: properties.map((property) => ({
        ...property,
        envelope: envelopes.get(property.id) ?? null,
      })),
      unknownPropertyIds: [...new Set(input.propertyIds)].filter((id) => !found.has(id)),
    };
  });

export const introspectExplain = graphReadRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:read", scope: { kind: "graphProperty", id: input.id } }),
  );
  const explanation = unwrap(await graph.introspect.explain(input.id, scope));
  const { access } = await publishedAccess(context.iam, scope.siteId);
  if (access && !(await access.property(input.id))) {
    return { ...explanation, current: { valueAvailable: false, envelope: null } };
  }
  const { available, envelopes } = await readGraphValues([input.id]);
  const envelope = envelopes.get(input.id);
  const readable = !envelope || !access || (await access.property(input.id, new Set(), envelope.timestamp));
  return {
    ...explanation,
    current: { valueAvailable: available, envelope: readable ? (envelope ?? null) : null },
  };
});

export const introspectConformance = graphReadRequired.input(siteInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:read", scope: { kind: "site", siteId: input.siteId } }),
  );
  return unwrap(await graph.introspect.conformance(scope));
});

const planNodeInputSchema = z.object({
  ref: z.string().min(1),
  name: z.string().min(1),
  typeRef: z.string().min(1).nullable().optional(),
  typeContext: jsonObjectSchema.optional(),
  materializeTypeFields: z.boolean().optional(),
});

const planPropertyInputSchema = z.object({
  id: z.uuid().optional(),
  nodeId: z.uuid().optional(),
  nodeRef: z.string().min(1).optional(),
  name: z.string().min(1),
  resolverType: z.string().min(1),
  resolver: jsonObjectSchema,
  sampleRateMs: z.number().int().positive().nullable().optional(),
});

const planHookInputSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  condition: jsonObjectSchema,
  eventNamespace: z.string().min(1),
  eventName: z.string().min(1),
  eventVersion: z.string().min(1).optional(),
  eventPayload: jsonObjectSchema.optional(),
  eventContext: jsonObjectSchema.optional(),
});

const planInputSchema = z.object({
  siteId: z.uuid(),
  nodes: z.array(planNodeInputSchema).max(50).optional(),
  properties: z.array(planPropertyInputSchema).max(200).optional(),
  hooks: z.array(planHookInputSchema).max(50).optional(),
});

// Dry-run a whole changeset: every issue reported at once, nothing written.
// Requires configuration:write — a plan is a rehearsal of writes and can probe names/ids.
export const introspectPlan = authRequired.input(planInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...changeset } = input;
  const scope = grant(
    await authorize(context.iam, { permission: "configuration:write", scope: { kind: "site", siteId } }),
  );
  return unwrap(await graph.planner.plan(changeset, scope));
});

const introspectDiagnosticsInputSchema = z.object({
  siteId: z.uuid(),
  // Bounds the KV scan; sites larger than this report scannedProperties < totalProperties.
  scanLimit: z.number().int().min(1).max(5000).default(2000),
});

// Properties whose current value is degraded (quality != good), with the
// error context the engine attached — the repair entry point for builders.
export const introspectDiagnostics = graphReadRequired
  .input(introspectDiagnosticsInputSchema)
  .handler(async ({ input, context }) => {
    const scope = grant(
      await authorize(context.iam, { permission: "configuration:read", scope: { kind: "site", siteId: input.siteId } }),
    );
    const snapshot = unwrap(await graph.introspect.snapshot(scope));
    const { access } = await publishedAccess(context.iam, scope.siteId);
    const scanned = [];
    for (const property of snapshot.properties.slice(0, input.scanLimit)) {
      if (!access || (await access.property(property.id))) scanned.push(property);
    }
    const { available, envelopes } = await readGraphValues(scanned.map((p) => p.id));
    if (access)
      for (const property of scanned) {
        const envelope = envelopes.get(property.id);
        if (envelope && !(await access.property(property.id, new Set(), envelope.timestamp)))
          envelopes.delete(property.id);
      }
    const nodeNames = new Map(snapshot.nodes.map((node) => [node.id, node.name]));
    return {
      graphVersion: snapshot.graphVersion,
      valuesAvailable: available,
      totalProperties: snapshot.properties.length,
      scannedProperties: scanned.length,
      unhealthy: available
        ? scanned.flatMap((property) => {
            const envelope = envelopes.get(property.id);
            if (envelope && envelope.quality === "good") return [];
            return [
              {
                propertyId: property.id,
                name: property.name,
                nodeId: property.nodeId,
                nodeName: nodeNames.get(property.nodeId) ?? null,
                resolverType: property.resolverType,
                // null envelope: never evaluated (or value store missed it).
                envelope: envelope ?? null,
              },
            ];
          })
        : [],
    };
  });

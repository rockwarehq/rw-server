import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { normalizeGraphTypeToken, parseGraphTypeRef } from "@rw/runtime/livestore-graph-types";

import { SYSTEM_ENTITY_KEYS, systemEntityCatalogEntryByKey } from "../entity/registry.js";
import type { EntityCatalogField } from "../entity/registry.types.js";
import { publishGraphDefinitionEvent } from "./definition-events.js";
import { activeHookIdsForProperties } from "./hooks.js";
import * as nodeTypes from "./node-types.js";
import {
  graphNodeInclude,
  graphNodeSiteWhere,
  getGraphNodeForSite,
  getGraphNodeSiteId,
  getGraphSiteForWorkspace,
} from "./scope.js";
import { errorResult, type GraphScope, type ListResult, type ServiceResult } from "./types.js";
import { validateAcyclicStaticEdges, validateResolverConfig } from "./validation.js";

export interface CreateGraphNodeInput {
  name: string;
  typeRef?: string | null;
  typeContext?: Record<string, unknown>;
  materializeTypeFields?: boolean;
}

export interface UpdateGraphNodeInput {
  name?: string;
  typeRef?: string | null;
  typeContext?: Record<string, unknown> | null;
}

export interface ListGraphNodesFilter {
  typeRef?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

export interface QueryGraphNodesFilter extends ListGraphNodesFilter {
  facets?: Record<string, unknown>;
  properties?: string[];
}

interface PreparedTypeField {
  id: string;
  name: string;
  typeFieldKey: string;
  resolverType: string;
  resolver: Record<string, unknown>;
  dependencyIds: string[];
  sampleRateMs: number | null;
}

type ResolvedGraphType = nodeTypes.ResolvedGraphType;

interface EntityResolverConfig {
  type: "entity";
  entityRef: {
    key: string;
    id: string;
  };
  path: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTypeContext(value: unknown): Record<string, unknown> | { error: string; code: string } {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return errorResult("INVALID_TYPE_CONTEXT", "typeContext must be an object");
  return value;
}

function normalizeFacetFilters(value: unknown): Record<string, unknown> | { error: string; code: string } {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return errorResult("INVALID_FACETS", "facets must be an object");
  return value;
}

function normalizeTypeRefForFilter(typeRef: string | undefined): string | false | undefined {
  if (!typeRef) return undefined;
  try {
    return parseGraphTypeRef(typeRef).typeRef;
  } catch {
    return false;
  }
}

function expandTemplate(value: unknown, context: Record<string, unknown>): unknown | { error: string; code: string } {
  if (typeof value === "string") {
    const match = /^\$(?:context|input)\.([a-zA-Z0-9_-]+)$/.exec(value);
    if (!match) return value;
    const key = match[1];
    if (!(key in context)) return errorResult("MISSING_TYPE_CONTEXT", `Missing graph type input value: ${key}`);
    return context[key];
  }

  if (Array.isArray(value)) {
    const expanded = [];
    for (const item of value) {
      const result = expandTemplate(item, context);
      if (isServiceError(result)) return result;
      expanded.push(result);
    }
    return expanded;
  }

  if (isRecord(value)) {
    const expanded: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = expandTemplate(item, context);
      if (isServiceError(result)) return result;
      expanded[key] = result;
    }
    return expanded;
  }

  return value;
}

function isServiceError(value: unknown): value is { error: string; code: string } {
  return isRecord(value) && typeof value.error === "string" && typeof value.code === "string";
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function normalizePropertyKeys(properties: string[] | undefined): string[] {
  const keys = new Set<string>();
  for (const property of properties ?? []) keys.add(normalizeGraphTypeToken(property));
  return [...keys];
}

function parseEntityResolver(value: Record<string, unknown>): EntityResolverConfig | null {
  if (value.type !== "entity") return null;
  if (!isRecord(value.entityRef)) return null;
  const key = value.entityRef.key;
  const id = value.entityRef.id;
  const path = value.path;
  if (typeof key !== "string" || typeof id !== "string" || typeof path !== "string") return null;
  return { type: "entity", entityRef: { key, id }, path };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function inputMatchesValueType(value: unknown, valueType: string): boolean {
  if (valueType === "string" || valueType === "entityRef" || valueType === "date") return typeof value === "string";
  if (valueType === "number" || valueType === "percent") return typeof value === "number" && Number.isFinite(value);
  if (valueType === "boolean") return typeof value === "boolean";
  if (valueType === "object" || valueType === "json") return value !== undefined;
  return false;
}

async function validateEntityRef(
  entityKey: string,
  entityId: string,
  scope: GraphScope,
): Promise<{ success: true } | { error: string; code: string }> {
  if (!entityId) return errorResult("ENTITY_REF_REQUIRED", "Entity reference id is required");

  if (entityKey === SYSTEM_ENTITY_KEYS.Site) {
    if (entityId !== scope.siteId) return errorResult("ENTITY_SITE_MISMATCH", "Entity reference is outside this site");
    const site = await prisma.site.findFirst({
      where: { id: entityId, workspaceId: scope.workspaceId },
      select: { id: true },
    });
    return site ? { success: true } : errorResult("ENTITY_REF_NOT_FOUND", "Entity reference was not found");
  }

  if (entityKey === SYSTEM_ENTITY_KEYS.Workcenter) {
    const workcenter = await prisma.workcenter.findFirst({
      where: { id: entityId, siteId: scope.siteId, site: { workspaceId: scope.workspaceId } },
      select: { id: true },
    });
    return workcenter ? { success: true } : errorResult("ENTITY_REF_NOT_FOUND", "Entity reference was not found");
  }

  if (entityKey === SYSTEM_ENTITY_KEYS.Station) {
    const station = await prisma.station.findFirst({
      where: { id: entityId, siteId: scope.siteId, site: { workspaceId: scope.workspaceId } },
      select: { id: true },
    });
    return station ? { success: true } : errorResult("ENTITY_REF_NOT_FOUND", "Entity reference was not found");
  }

  const schema = await prisma.objectSchema.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      siteId: scope.siteId,
      source: "DOCUMENT",
      isDeleted: false,
      OR: [...(UUID_PATTERN.test(entityKey) ? [{ id: entityKey }] : []), { key: entityKey }],
    },
    select: { id: true },
  });
  if (!schema) return errorResult("ENTITY_REF_SCHEMA_NOT_FOUND", "Entity reference schema was not found");

  const instance = await prisma.objectInstance.findFirst({
    where: { id: entityId, schemaId: schema.id, siteId: scope.siteId, isDeleted: false },
    select: { id: true },
  });
  return instance ? { success: true } : errorResult("ENTITY_REF_NOT_FOUND", "Entity reference was not found");
}

async function validateTypeInputs(args: {
  type: ResolvedGraphType | null;
  typeContext: Record<string, unknown>;
  scope: GraphScope;
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!args.type) return { data: args.typeContext };

  for (const input of args.type.inputs) {
    const value = args.typeContext[input.key];
    if (!isPresent(value)) {
      if (input.required) return errorResult("MISSING_TYPE_INPUT", `Missing graph type input value: ${input.key}`);
      continue;
    }
    if (!inputMatchesValueType(value, input.valueType)) {
      return errorResult("INVALID_TYPE_INPUT", `Graph type input "${input.key}" has invalid value`);
    }
    if (input.valueType === "entityRef") {
      if (!input.entityKey)
        return errorResult("INVALID_TYPE_INPUT", `Graph type input "${input.key}" is missing entityKey`);
      const refResult = await validateEntityRef(input.entityKey, String(value), args.scope);
      if ("error" in refResult) return refResult;
    }
  }

  return { data: args.typeContext };
}

async function entityCatalogField(
  entityKey: string,
  path: string,
  scope: GraphScope,
): Promise<ServiceResult<EntityCatalogField>> {
  const systemEntry = systemEntityCatalogEntryByKey(entityKey, true);
  if (systemEntry?.fields) {
    const field = systemEntry.fields.find((candidate) => candidate.key === path || candidate.path === path);
    return field ? { data: field } : errorResult("ENTITY_PATH_NOT_FOUND", `Entity path not found: ${path}`);
  }

  const schema = await prisma.objectSchema.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      siteId: scope.siteId,
      source: "DOCUMENT",
      isDeleted: false,
      OR: [...(UUID_PATTERN.test(entityKey) ? [{ id: entityKey }] : []), { key: entityKey }],
    },
    include: { fields: { where: { isDeleted: false } } },
  });
  if (!schema) return errorResult("ENTITY_REF_SCHEMA_NOT_FOUND", "Entity reference schema was not found");

  const field = schema.fields.find((candidate) => candidate.key === path || candidate.name === path);
  if (!field) return errorResult("ENTITY_PATH_NOT_FOUND", `Entity path not found: ${path}`);
  return {
    data: {
      key: field.key,
      name: field.key,
      label: field.label,
      type: field.type,
      description: field.description,
      required: field.required,
      isList: field.isList,
      path: field.key,
      relation: field.refSchemaId ? { key: field.key, targetKey: field.refSchemaId } : null,
      sortOrder: field.sortOrder,
    },
  };
}

async function resolveSystemEntityValue(
  entityKey: string,
  entityId: string,
  path: string,
  scope: GraphScope,
): Promise<ServiceResult<unknown>> {
  if (entityKey === SYSTEM_ENTITY_KEYS.Site) {
    const site = await prisma.site.findFirst({
      where: { id: entityId, workspaceId: scope.workspaceId },
      select: { id: true, name: true, description: true, timezone: true, attrs: true },
    });
    if (!site || site.id !== scope.siteId) return errorResult("ENTITY_REF_NOT_FOUND", "Entity reference was not found");
    if (path === "workcenters") {
      const workcenters = await prisma.workcenter.findMany({ where: { siteId: site.id }, select: { id: true } });
      return { data: workcenters.map((workcenter) => workcenter.id) };
    }
    if (path === "stations") {
      const stations = await prisma.station.findMany({ where: { siteId: site.id }, select: { id: true } });
      return { data: stations.map((station) => station.id) };
    }
    return { data: jsonRecord(site)[path] ?? null };
  }

  if (entityKey === SYSTEM_ENTITY_KEYS.Workcenter) {
    const workcenter = await prisma.workcenter.findFirst({
      where: { id: entityId, siteId: scope.siteId, site: { workspaceId: scope.workspaceId } },
      select: { id: true, name: true, description: true, attrs: true, siteId: true, parentId: true },
    });
    if (!workcenter) return errorResult("ENTITY_REF_NOT_FOUND", "Entity reference was not found");
    if (path === "site") return { data: workcenter.siteId };
    if (path === "parent") return { data: workcenter.parentId };
    if (path === "children") {
      const children = await prisma.workcenter.findMany({ where: { parentId: workcenter.id }, select: { id: true } });
      return { data: children.map((child) => child.id) };
    }
    if (path === "stations") {
      const stations = await prisma.station.findMany({ where: { workcenterId: workcenter.id }, select: { id: true } });
      return { data: stations.map((station) => station.id) };
    }
    return { data: jsonRecord(workcenter)[path] ?? null };
  }

  if (entityKey === SYSTEM_ENTITY_KEYS.Station) {
    const station = await prisma.station.findFirst({
      where: { id: entityId, siteId: scope.siteId, site: { workspaceId: scope.workspaceId } },
      select: { id: true, name: true, description: true, attrs: true, siteId: true, workcenterId: true },
    });
    if (!station) return errorResult("ENTITY_REF_NOT_FOUND", "Entity reference was not found");
    if (path === "site") return { data: station.siteId };
    if (path === "workcenter") return { data: station.workcenterId };
    return { data: jsonRecord(station)[path] ?? null };
  }

  return errorResult("ENTITY_REF_SCHEMA_NOT_FOUND", "Entity reference schema was not found");
}

async function resolveUserEntityValue(
  entityKey: string,
  entityId: string,
  path: string,
  scope: GraphScope,
): Promise<ServiceResult<unknown>> {
  const schema = await prisma.objectSchema.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      siteId: scope.siteId,
      source: "DOCUMENT",
      isDeleted: false,
      OR: [...(UUID_PATTERN.test(entityKey) ? [{ id: entityKey }] : []), { key: entityKey }],
    },
    select: { id: true },
  });
  if (!schema) return errorResult("ENTITY_REF_SCHEMA_NOT_FOUND", "Entity reference schema was not found");

  const instance = await prisma.objectInstance.findFirst({
    where: { id: entityId, schemaId: schema.id, siteId: scope.siteId, isDeleted: false },
    select: { id: true, values: true },
  });
  if (!instance) return errorResult("ENTITY_REF_NOT_FOUND", "Entity reference was not found");
  if (path === "id") return { data: instance.id };
  return { data: jsonRecord(instance.values)[path] ?? null };
}

async function resolveEntityFacetValue(
  resolver: EntityResolverConfig,
  scope: GraphScope,
): Promise<ServiceResult<unknown>> {
  const fieldResult = await entityCatalogField(resolver.entityRef.key, resolver.path, scope);
  if ("error" in fieldResult) return fieldResult;

  if (systemEntityCatalogEntryByKey(resolver.entityRef.key, false)) {
    return resolveSystemEntityValue(resolver.entityRef.key, resolver.entityRef.id, resolver.path, scope);
  }
  return resolveUserEntityValue(resolver.entityRef.key, resolver.entityRef.id, resolver.path, scope);
}

async function materializeTypeFacets(args: {
  type: ResolvedGraphType | null;
  typeContext: Record<string, unknown>;
  scope: GraphScope;
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!args.type) return { data: {} };

  const facets: Record<string, unknown> = {};
  for (const facet of args.type.facets) {
    if (facet.resolverType !== "entity") {
      return errorResult("INVALID_FACET_RESOLVER", `Unsupported graph type facet resolverType: ${facet.resolverType}`);
    }
    const expanded = expandTemplate(facet.resolver, args.typeContext);
    if (isServiceError(expanded)) return expanded;
    if (!isRecord(expanded))
      return errorResult("INVALID_FACET_RESOLVER", `Graph type facet resolver is invalid: ${facet.key}`);
    const resolver = parseEntityResolver(expanded);
    if (!resolver) return errorResult("INVALID_FACET_RESOLVER", `Graph type facet resolver is invalid: ${facet.key}`);
    const valueResult = await resolveEntityFacetValue(resolver, args.scope);
    if ("error" in valueResult) return valueResult;
    if (!isPresent(valueResult.data) && facet.required) {
      return errorResult("MISSING_REQUIRED_FACET", `Graph type facet "${facet.key}" resolved no value`);
    }
    facets[facet.key] = valueResult.data ?? null;
  }

  return { data: facets };
}

async function prepareTypeFields(args: {
  nodeId: string;
  typeRef: string | null;
  typeContext: Record<string, unknown>;
  scope: GraphScope;
}): Promise<ServiceResult<PreparedTypeField[]>> {
  if (!args.typeRef) return { data: [] };
  const typeResult = await nodeTypes.resolve(args.typeRef, args.scope);
  if ("error" in typeResult) return typeResult;

  const existingProperties = await prisma.graphProperty.findMany({
    where: { nodeId: args.nodeId, name: { in: typeResult.data.fields.map((field) => field.key) } },
    select: { id: true, name: true },
  });
  const existingByName = new Map(existingProperties.map((property) => [property.name, property.id]));

  const prepared: PreparedTypeField[] = [];
  for (const field of typeResult.data.fields) {
    const expanded = expandTemplate(field.resolver, args.typeContext);
    if (isServiceError(expanded)) return expanded;
    if (!isRecord(expanded))
      return errorResult("INVALID_RESOLVER", `Graph type field resolver is invalid: ${field.key}`);

    const resolverResult = await validateResolverConfig({
      resolverType: field.resolverType,
      resolver: expanded,
      scope: args.scope,
    });
    if ("error" in resolverResult) return resolverResult;

    const propertyId = existingByName.get(field.key) ?? randomUUID();
    const cycleResult = await validateAcyclicStaticEdges({
      propertyId,
      dependencyIds: resolverResult.data.dependencyIds,
    });
    if ("error" in cycleResult) return cycleResult;

    prepared.push({
      id: propertyId,
      name: field.key,
      typeFieldKey: field.key,
      resolverType: resolverResult.data.resolver.type as string,
      resolver: resolverResult.data.resolver,
      dependencyIds: resolverResult.data.dependencyIds,
      sampleRateMs: field.sampleRateMs ?? null,
    });
  }

  return { data: prepared };
}

export async function create(input: CreateGraphNodeInput, scope: GraphScope): Promise<ServiceResult<unknown>> {
  const name = input.name.trim();
  if (!name) return errorResult("INVALID_NAME", "Graph node name is required");

  const siteResult = await getGraphSiteForWorkspace(scope.siteId, scope.workspaceId);
  if ("error" in siteResult) return siteResult;

  const typeContext = normalizeTypeContext(input.typeContext);
  if (isServiceError(typeContext)) return typeContext;

  let typeRef: string | null = null;
  let resolvedType: ResolvedGraphType | null = null;
  if (input.typeRef) {
    const typeResult = await nodeTypes.resolve(input.typeRef, scope);
    if ("error" in typeResult) return typeResult;
    typeRef = typeResult.data.typeRef;
    resolvedType = typeResult.data;
  }

  const inputResult = await validateTypeInputs({ type: resolvedType, typeContext, scope });
  if ("error" in inputResult) return inputResult;

  const facetsResult = await materializeTypeFacets({ type: resolvedType, typeContext, scope });
  if ("error" in facetsResult) return facetsResult;

  const existing = await prisma.graphNode.findUnique({
    where: { siteId_name: { siteId: scope.siteId, name } },
  });
  if (existing && !existing.isDeleted) return errorResult("GRAPH_NODE_NAME_EXISTS", "Graph node name already exists");

  const nodeId = existing?.id ?? randomUUID();
  const fieldsResult = input.materializeTypeFields
    ? await prepareTypeFields({ nodeId, typeRef, typeContext, scope })
    : { data: [] as PreparedTypeField[] };
  if ("error" in fieldsResult) return fieldsResult;

  const node = await prisma.$transaction(async (tx) => {
    const next = existing
      ? await tx.graphNode.update({
          where: { id: existing.id },
          data: {
            name,
            siteId: scope.siteId,
            typeRef,
            typeContext: typeContext as Prisma.InputJsonValue,
            facets: facetsResult.data as Prisma.InputJsonValue,
            isDeleted: false,
          },
        })
      : await tx.graphNode.create({
          data: {
            id: nodeId,
            name,
            siteId: scope.siteId,
            typeRef,
            typeContext: typeContext as Prisma.InputJsonValue,
            facets: facetsResult.data as Prisma.InputJsonValue,
          },
        });

    for (const field of fieldsResult.data) {
      const property = await tx.graphProperty.upsert({
        where: { nodeId_name: { nodeId: next.id, name: field.name } },
        create: {
          id: field.id,
          nodeId: next.id,
          name: field.name,
          typeFieldKey: field.typeFieldKey,
          resolverType: field.resolverType,
          resolver: field.resolver as Prisma.InputJsonValue,
          sampleRateMs: field.sampleRateMs,
        },
        update: {
          typeFieldKey: field.typeFieldKey,
          resolverType: field.resolverType,
          resolver: field.resolver as Prisma.InputJsonValue,
          sampleRateMs: field.sampleRateMs,
          isDeleted: false,
        },
      });
      await tx.graphEdge.deleteMany({ where: { toPropertyId: property.id } });
      if (field.dependencyIds.length > 0) {
        await tx.graphEdge.createMany({
          data: [...new Set(field.dependencyIds)].map((dependencyId) => ({
            fromPropertyId: dependencyId,
            toPropertyId: property.id,
          })),
          skipDuplicates: true,
        });
      }
    }

    return next;
  });

  const created = await prisma.graphNode.findUnique({ where: { id: node.id }, include: graphNodeInclude });
  publishGraphDefinitionEvent({ entity: "node", action: "created", entityId: node.id, siteId: scope.siteId });
  return { data: created };
}

export async function list(filter: ListGraphNodesFilter, scope: GraphScope): Promise<ListResult<unknown>> {
  const { name, limit = 50, offset = 0 } = filter;
  const typeRef = normalizeTypeRefForFilter(filter.typeRef);
  if (typeRef === false) return { data: [], total: 0, limit: Number(limit), offset: Number(offset) };
  const where = {
    ...graphNodeSiteWhere(scope),
    ...(typeRef ? { typeRef } : {}),
    ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
  };

  const [nodes, total] = await Promise.all([
    prisma.graphNode.findMany({
      where,
      include: graphNodeInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.graphNode.count({ where }),
  ]);

  return { data: nodes, total, limit: Number(limit), offset: Number(offset) };
}

export async function query(filter: QueryGraphNodesFilter, scope: GraphScope): Promise<ListResult<unknown>> {
  const { name, limit = 50, offset = 0 } = filter;
  const typeRef = normalizeTypeRefForFilter(filter.typeRef);
  if (typeRef === false) return { data: [], total: 0, limit: Number(limit), offset: Number(offset) };
  const facets = normalizeFacetFilters(filter.facets);
  if (isServiceError(facets)) return { data: [], total: 0, limit: Number(limit), offset: Number(offset) };
  const propertyKeys = normalizePropertyKeys(filter.properties);
  const facetFilters: Prisma.GraphNodeWhereInput[] = Object.entries(facets).map(([key, value]) => ({
    facets: { path: [key], equals: value as Prisma.InputJsonValue },
  }));
  const where: Prisma.GraphNodeWhereInput = {
    ...graphNodeSiteWhere(scope),
    ...(typeRef ? { typeRef } : {}),
    ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
    ...(facetFilters.length > 0 ? { AND: facetFilters } : {}),
  };

  const propertyWhere: Prisma.GraphPropertyWhereInput = {
    isDeleted: false,
    ...(propertyKeys.length > 0
      ? { OR: [{ typeFieldKey: { in: propertyKeys } }, { name: { in: propertyKeys } }] }
      : {}),
  };

  const [nodes, total] = await Promise.all([
    prisma.graphNode.findMany({
      where,
      include: {
        site: { select: { id: true, name: true, workspaceId: true } },
        properties: {
          where: propertyWhere,
          orderBy: { name: "asc" as const },
        },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.graphNode.count({ where }),
  ]);

  return {
    data: nodes.map((node) => ({
      ...node,
      requestedProperties:
        propertyKeys.length > 0
          ? Object.fromEntries(
              propertyKeys.map((key) => [
                key,
                node.properties.find((property) => property.typeFieldKey === key || property.name === key) ?? null,
              ]),
            )
          : undefined,
    })),
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

export async function refreshFacetsForEntity(input: {
  entityKey: string;
  entityId: string;
  scope: GraphScope;
}): Promise<ServiceResult<{ refreshed: number; changed: number }>> {
  const nodes = await prisma.graphNode.findMany({
    where: graphNodeSiteWhere(input.scope),
    select: { id: true, typeRef: true, typeContext: true, facets: true },
  });

  let refreshed = 0;
  let changed = 0;
  for (const node of nodes) {
    if (!node.typeRef) continue;
    const typeResult = await nodeTypes.resolve(node.typeRef, input.scope);
    if ("error" in typeResult) continue;

    const typeContext = normalizeTypeContext(node.typeContext);
    if (isServiceError(typeContext)) continue;
    const referencesEntity = typeResult.data.inputs.some(
      (typeInput) =>
        typeInput.valueType === "entityRef" &&
        typeInput.entityKey === input.entityKey &&
        typeContext[typeInput.key] === input.entityId,
    );
    if (!referencesEntity) continue;

    const facetsResult = await materializeTypeFacets({ type: typeResult.data, typeContext, scope: input.scope });
    if ("error" in facetsResult) return facetsResult;
    refreshed += 1;
    if (JSON.stringify(jsonRecord(node.facets)) === JSON.stringify(facetsResult.data)) continue;
    await prisma.graphNode.update({
      where: { id: node.id },
      data: { facets: facetsResult.data as Prisma.InputJsonValue },
    });
    changed += 1;
  }

  return { data: { refreshed, changed } };
}

export async function refreshFacetsForType(input: {
  typeRef: string;
  scope: GraphScope;
}): Promise<ServiceResult<{ refreshed: number; changed: number }>> {
  const typeResult = await nodeTypes.resolve(input.typeRef, input.scope);
  if ("error" in typeResult) return typeResult;

  const nodes = await prisma.graphNode.findMany({
    where: { ...graphNodeSiteWhere(input.scope), typeRef: typeResult.data.typeRef },
    select: { id: true, typeContext: true, facets: true },
  });

  let refreshed = 0;
  let changed = 0;
  for (const node of nodes) {
    const typeContext = normalizeTypeContext(node.typeContext);
    if (isServiceError(typeContext)) continue;
    const facetsResult = await materializeTypeFacets({ type: typeResult.data, typeContext, scope: input.scope });
    if ("error" in facetsResult) return facetsResult;
    refreshed += 1;
    if (JSON.stringify(jsonRecord(node.facets)) === JSON.stringify(facetsResult.data)) continue;
    await prisma.graphNode.update({
      where: { id: node.id },
      data: { facets: facetsResult.data as Prisma.InputJsonValue },
    });
    changed += 1;
  }

  return { data: { refreshed, changed } };
}

export async function getById(id: string, scope: GraphScope): Promise<ServiceResult<unknown> | null> {
  return getGraphNodeForSite(id, scope);
}

export async function getSiteId(id: string, workspaceId: string): Promise<ServiceResult<string> | null> {
  return getGraphNodeSiteId(id, workspaceId);
}

export async function update(
  id: string,
  input: UpdateGraphNodeInput,
  scope: GraphScope,
): Promise<ServiceResult<unknown>> {
  const currentResult = await getGraphNodeForSite(id, scope);
  if (!currentResult) return errorResult("GRAPH_NODE_NOT_FOUND", "Graph node not found");
  if ("error" in currentResult) return currentResult;
  const current = currentResult.data;

  const updateData: Record<string, unknown> = {};
  let nextTypeRef = current.typeRef;
  let nextTypeContext = normalizeTypeContext(current.typeContext);
  if (isServiceError(nextTypeContext)) return nextTypeContext;
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return errorResult("INVALID_NAME", "Graph node name is required");
    if (name !== current.name) {
      const conflict = await prisma.graphNode.findUnique({ where: { siteId_name: { siteId: scope.siteId, name } } });
      if (conflict) return errorResult("GRAPH_NODE_NAME_EXISTS", "Graph node name already exists");
    }
    updateData.name = name;
  }

  if (input.typeRef !== undefined) {
    if (input.typeRef === null) {
      updateData.typeRef = null;
      nextTypeRef = null;
    } else {
      const typeResult = await nodeTypes.resolve(input.typeRef, scope);
      if ("error" in typeResult) return typeResult;
      updateData.typeRef = typeResult.data.typeRef;
      nextTypeRef = typeResult.data.typeRef;
    }
  }

  if (input.typeContext !== undefined) {
    const typeContext = normalizeTypeContext(input.typeContext);
    if (isServiceError(typeContext)) return typeContext;
    updateData.typeContext = typeContext as Prisma.InputJsonValue;
    nextTypeContext = typeContext;
  }

  if (input.typeRef !== undefined || input.typeContext !== undefined) {
    let resolvedType: ResolvedGraphType | null = null;
    if (nextTypeRef) {
      const typeResult = await nodeTypes.resolve(nextTypeRef, scope);
      if ("error" in typeResult) return typeResult;
      resolvedType = typeResult.data;
    }
    const inputResult = await validateTypeInputs({ type: resolvedType, typeContext: nextTypeContext, scope });
    if ("error" in inputResult) return inputResult;

    const facetsResult = await materializeTypeFacets({ type: resolvedType, typeContext: nextTypeContext, scope });
    if ("error" in facetsResult) return facetsResult;
    updateData.facets = facetsResult.data as Prisma.InputJsonValue;
  }

  if (Object.keys(updateData).length === 0) return { data: current };

  const node = await prisma.graphNode.update({ where: { id }, data: updateData, include: graphNodeInclude });
  publishGraphDefinitionEvent({ entity: "node", action: "updated", entityId: id, siteId: scope.siteId });
  return { data: node };
}

export async function remove(id: string, scope: GraphScope): Promise<ServiceResult<{ success: true }>> {
  const currentResult = await getGraphNodeForSite(id, scope);
  if (!currentResult) return errorResult("GRAPH_NODE_NOT_FOUND", "Graph node not found");
  if ("error" in currentResult) return currentResult;

  const properties = await prisma.graphProperty.findMany({
    where: { nodeId: id, isDeleted: false },
    select: { id: true },
  });
  const propertyIds = properties.map((property) => property.id);

  if (propertyIds.length > 0) {
    const externalDependentCount = await prisma.graphEdge.count({
      where: {
        fromPropertyId: { in: propertyIds },
        toProperty: { isDeleted: false, node: { ...graphNodeSiteWhere(scope), id: { not: id } } },
      },
    });
    if (externalDependentCount > 0)
      return errorResult(
        "GRAPH_NODE_HAS_EXTERNAL_DEPENDENTS",
        "Cannot delete a node with properties used by other nodes",
      );

    const hookIds = await activeHookIdsForProperties(propertyIds, scope);
    if (hookIds.length > 0)
      return errorResult("GRAPH_NODE_HAS_HOOKS", "Cannot delete a node with properties used by active graph hooks");
  }

  await prisma.$transaction([
    ...(propertyIds.length > 0
      ? [
          prisma.graphEdge.deleteMany({
            where: { OR: [{ fromPropertyId: { in: propertyIds } }, { toPropertyId: { in: propertyIds } }] },
          }),
        ]
      : []),
    prisma.graphProperty.updateMany({ where: { nodeId: id }, data: { isDeleted: true } }),
    prisma.graphNode.update({ where: { id }, data: { isDeleted: true } }),
  ]);

  publishGraphDefinitionEvent({ entity: "node", action: "deleted", entityId: id, siteId: scope.siteId });
  return { data: { success: true } };
}

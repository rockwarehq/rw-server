import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { parseGraphTypeRef } from "@rw/runtime/livestore-graph-types";

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

interface PreparedTypeField {
  id: string;
  name: string;
  typeFieldKey: string;
  resolverType: string;
  resolver: Record<string, unknown>;
  dependencyIds: string[];
  sampleRateMs: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTypeContext(value: unknown): Record<string, unknown> | { error: string; code: string } {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return errorResult("INVALID_TYPE_CONTEXT", "typeContext must be an object");
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
    const match = /^\$context\.([a-zA-Z0-9_-]+)$/.exec(value);
    if (!match) return value;
    const key = match[1];
    if (!(key in context)) return errorResult("MISSING_TYPE_CONTEXT", `Missing typeContext value: ${key}`);
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
    if (!isRecord(expanded)) return errorResult("INVALID_RESOLVER", `Graph type field resolver is invalid: ${field.key}`);

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
  if (input.typeRef) {
    const typeResult = await nodeTypes.resolve(input.typeRef, scope);
    if ("error" in typeResult) return typeResult;
    typeRef = typeResult.data.typeRef;
  }

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
    } else {
      const typeResult = await nodeTypes.resolve(input.typeRef, scope);
      if ("error" in typeResult) return typeResult;
      updateData.typeRef = typeResult.data.typeRef;
    }
  }

  if (input.typeContext !== undefined) {
    const typeContext = normalizeTypeContext(input.typeContext);
    if (isServiceError(typeContext)) return typeContext;
    updateData.typeContext = typeContext as Prisma.InputJsonValue;
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

  const properties = await prisma.graphProperty.findMany({ where: { nodeId: id, isDeleted: false }, select: { id: true } });
  const propertyIds = properties.map((property) => property.id);

  if (propertyIds.length > 0) {
    const externalDependentCount = await prisma.graphEdge.count({
      where: {
        fromPropertyId: { in: propertyIds },
        toProperty: { isDeleted: false, node: { ...graphNodeSiteWhere(scope), id: { not: id } } },
      },
    });
    if (externalDependentCount > 0)
      return errorResult("GRAPH_NODE_HAS_EXTERNAL_DEPENDENTS", "Cannot delete a node with properties used by other nodes");

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

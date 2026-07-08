import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

import { getGraphNodeForSite, getGraphPropertyForSite, getGraphPropertySiteId, graphNodeSiteWhere } from "./scope.js";
import { publishGraphDefinitionEvent } from "./definition-events.js";
import { errorResult, type GraphScope, type ListResult, type ServiceResult } from "./types.js";
import { isRecordResolver, validateAcyclicStaticEdges, validateResolverConfig } from "./validation.js";
import { activeHookIdsForProperties } from "./hooks.js";

export interface CreateGraphPropertyInput {
  nodeId: string;
  name: string;
  typeFieldKey?: string | null;
  resolverType?: string;
  resolver?: Record<string, unknown>;
  sampleRateMs?: number | null;
}

export interface UpdateGraphPropertyInput {
  name?: string;
  typeFieldKey?: string | null;
  resolverType?: string;
  resolver?: Record<string, unknown>;
  sampleRateMs?: number | null;
}

export interface ListGraphPropertiesFilter {
  nodeId?: string;
  name?: string;
  resolverType?: string;
  limit?: number;
  offset?: number;
}

export interface ValidateGraphPropertyInput extends CreateGraphPropertyInput {
  id?: string;
}

async function buildResolver(args: { resolverType?: string; resolver?: Record<string, unknown>; scope: GraphScope }) {
  const resolverType = args.resolverType;
  const resolver = args.resolver;

  if (!resolverType || !resolver || !isRecordResolver(resolver))
    return errorResult("RESOLVER_REQUIRED", "resolverType and resolver are required");

  return validateResolverConfig({ resolverType, resolver, scope: args.scope });
}

function validateSampleRate(sampleRateMs: number | null | undefined) {
  if (sampleRateMs === null || sampleRateMs === undefined) return null;
  return Number.isInteger(sampleRateMs) && sampleRateMs > 0
    ? null
    : errorResult("INVALID_SAMPLE_RATE", "sampleRateMs must be a positive integer");
}

export async function create(input: CreateGraphPropertyInput, scope: GraphScope): Promise<ServiceResult<unknown>> {
  const nodeResult = await getGraphNodeForSite(input.nodeId, scope);
  if (!nodeResult) return errorResult("GRAPH_NODE_NOT_FOUND", "Graph node not found");
  if ("error" in nodeResult) return nodeResult;

  const name = input.name.trim();
  if (!name) return errorResult("INVALID_NAME", "Graph property name is required");

  const sampleRateError = validateSampleRate(input.sampleRateMs);
  if (sampleRateError) return sampleRateError;

  const existing = await prisma.graphProperty.findUnique({ where: { nodeId_name: { nodeId: input.nodeId, name } } });
  if (existing && !existing.isDeleted)
    return errorResult("GRAPH_PROPERTY_NAME_EXISTS", "Graph property name already exists on this node");

  const resolverResult = await buildResolver({
    resolverType: input.resolverType,
    resolver: input.resolver,
    scope,
  });
  if ("error" in resolverResult) return resolverResult;

  const propertyId = existing?.id ?? randomUUID();
  const cycleResult = await validateAcyclicStaticEdges({
    propertyId,
    dependencyIds: resolverResult.data.dependencyIds,
  });
  if ("error" in cycleResult) return cycleResult;

  const property = await prisma.$transaction(async (tx) => {
    const next = existing
      ? await tx.graphProperty.update({
          where: { id: existing.id },
          data: {
            nodeId: input.nodeId,
            name,
            typeFieldKey: input.typeFieldKey ?? null,
            resolverType: resolverResult.data.resolver.type as string,
            resolver: resolverResult.data.resolver as Prisma.InputJsonValue,
            sampleRateMs: input.sampleRateMs ?? null,
            isDeleted: false,
          },
        })
      : await tx.graphProperty.create({
          data: {
            id: propertyId,
            nodeId: input.nodeId,
            name,
            typeFieldKey: input.typeFieldKey ?? null,
            resolverType: resolverResult.data.resolver.type as string,
            resolver: resolverResult.data.resolver as Prisma.InputJsonValue,
            sampleRateMs: input.sampleRateMs ?? null,
          },
        });
    await tx.graphEdge.deleteMany({ where: { toPropertyId: next.id } });
    if (resolverResult.data.dependencyIds.length > 0) {
      await tx.graphEdge.createMany({
        data: [...new Set(resolverResult.data.dependencyIds)].map((dependencyId) => ({
          fromPropertyId: dependencyId,
          toPropertyId: next.id,
        })),
        skipDuplicates: true,
      });
    }
    return next;
  });

  publishGraphDefinitionEvent({
    entity: "property",
    action: "created",
    entityId: property.id,
    nodeId: property.nodeId,
    siteId: scope.siteId,
  });

  return { data: property };
}

export async function update(
  id: string,
  input: UpdateGraphPropertyInput,
  scope: GraphScope,
): Promise<ServiceResult<unknown>> {
  const currentResult = await getGraphPropertyForSite(id, scope);
  if (!currentResult) return errorResult("GRAPH_PROPERTY_NOT_FOUND", "Graph property not found");
  if ("error" in currentResult) return currentResult;
  const current = currentResult.data;

  const name = (input.name ?? current.name).trim();
  if (!name) return errorResult("INVALID_NAME", "Graph property name is required");
  if (name !== current.name) {
    const conflict = await prisma.graphProperty.findUnique({
      where: { nodeId_name: { nodeId: current.nodeId, name } },
    });
    if (conflict) return errorResult("GRAPH_PROPERTY_NAME_EXISTS", "Graph property name already exists on this node");
  }

  const sampleRateMs = input.sampleRateMs !== undefined ? input.sampleRateMs : current.sampleRateMs;
  const sampleRateError = validateSampleRate(sampleRateMs);
  if (sampleRateError) return sampleRateError;

  const currentResolver = isRecordResolver(current.resolver) ? current.resolver : { type: current.resolverType };
  const resolverResult = await buildResolver({
    resolverType: input.resolverType ?? current.resolverType,
    resolver: input.resolver ?? currentResolver,
    scope,
  });
  if ("error" in resolverResult) return resolverResult;

  const cycleResult = await validateAcyclicStaticEdges({
    propertyId: id,
    dependencyIds: resolverResult.data.dependencyIds,
  });
  if ("error" in cycleResult) return cycleResult;

  const property = await prisma.$transaction(async (tx) => {
    const next = await tx.graphProperty.update({
      where: { id },
      data: {
        name,
        ...(input.typeFieldKey !== undefined ? { typeFieldKey: input.typeFieldKey } : {}),
        resolverType: resolverResult.data.resolver.type as string,
        resolver: resolverResult.data.resolver as Prisma.InputJsonValue,
        sampleRateMs,
      },
    });
    await tx.graphEdge.deleteMany({ where: { toPropertyId: next.id } });
    if (resolverResult.data.dependencyIds.length > 0) {
      await tx.graphEdge.createMany({
        data: [...new Set(resolverResult.data.dependencyIds)].map((dependencyId) => ({
          fromPropertyId: dependencyId,
          toPropertyId: next.id,
        })),
        skipDuplicates: true,
      });
    }
    return next;
  });

  publishGraphDefinitionEvent({
    entity: "property",
    action: "updated",
    entityId: property.id,
    nodeId: property.nodeId,
    siteId: scope.siteId,
  });

  return { data: property };
}

export async function remove(id: string, scope: GraphScope): Promise<ServiceResult<{ success: true }>> {
  const currentResult = await getGraphPropertyForSite(id, scope);
  if (!currentResult) return errorResult("GRAPH_PROPERTY_NOT_FOUND", "Graph property not found");
  if ("error" in currentResult) return currentResult;
  const current = currentResult.data;

  const dependentCount = await prisma.graphEdge.count({
    where: { fromPropertyId: id, toProperty: { isDeleted: false, node: graphNodeSiteWhere(scope) } },
  });
  if (dependentCount > 0)
    return errorResult("GRAPH_PROPERTY_HAS_DEPENDENTS", "Cannot delete a property with active dependents");

  const hookIds = await activeHookIdsForProperties([id], scope);
  if (hookIds.length > 0)
    return errorResult("GRAPH_PROPERTY_HAS_HOOKS", "Cannot delete a property used by active graph hooks");

  await prisma.$transaction([
    prisma.graphEdge.deleteMany({ where: { OR: [{ fromPropertyId: id }, { toPropertyId: id }] } }),
    prisma.graphProperty.update({ where: { id }, data: { isDeleted: true } }),
  ]);

  publishGraphDefinitionEvent({
    entity: "property",
    action: "deleted",
    entityId: id,
    nodeId: current.nodeId,
    siteId: scope.siteId,
  });

  return { data: { success: true } };
}

export async function dependents(id: string, scope: GraphScope): Promise<ServiceResult<unknown[]>> {
  const currentResult = await getGraphPropertyForSite(id, scope);
  if (!currentResult) return errorResult("GRAPH_PROPERTY_NOT_FOUND", "Graph property not found");
  if ("error" in currentResult) return currentResult;

  const edges = await prisma.graphEdge.findMany({
    where: { fromPropertyId: id, toProperty: { isDeleted: false, node: graphNodeSiteWhere(scope) } },
    include: { toProperty: { include: { node: true } } },
    orderBy: { createdAt: "asc" },
  });

  return { data: edges.map((edge) => edge.toProperty) };
}

export async function validate(input: ValidateGraphPropertyInput, scope: GraphScope): Promise<ServiceResult<unknown>> {
  const nodeResult = await getGraphNodeForSite(input.nodeId, scope);
  if (!nodeResult) return errorResult("GRAPH_NODE_NOT_FOUND", "Graph node not found");
  if ("error" in nodeResult) return nodeResult;

  const resolverResult = await buildResolver({
    resolverType: input.resolverType,
    resolver: input.resolver,
    scope,
  });
  if ("error" in resolverResult) return resolverResult;

  const propertyId = input.id ?? randomUUID();
  const cycleResult = await validateAcyclicStaticEdges({
    propertyId,
    dependencyIds: resolverResult.data.dependencyIds,
  });
  if ("error" in cycleResult) return cycleResult;

  return {
    data: {
      resolver: resolverResult.data.resolver,
      dependencyIds: resolverResult.data.dependencyIds,
    },
  };
}

export async function getById(id: string, scope: GraphScope): Promise<ServiceResult<unknown> | null> {
  return getGraphPropertyForSite(id, scope);
}

export async function getSiteId(id: string, workspaceId: string): Promise<ServiceResult<string> | null> {
  return getGraphPropertySiteId(id, workspaceId);
}

export async function list(filter: ListGraphPropertiesFilter, scope: GraphScope): Promise<ListResult<unknown>> {
  const { nodeId, name, resolverType, limit = 50, offset = 0 } = filter;
  const where = {
    isDeleted: false,
    node: graphNodeSiteWhere(scope),
    ...(nodeId ? { nodeId } : {}),
    ...(resolverType ? { resolverType } : {}),
    ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
  };

  const [properties, total] = await Promise.all([
    prisma.graphProperty.findMany({
      where,
      include: {
        node: { select: { id: true, name: true, siteId: true, typeRef: true, typeContext: true } },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: [{ node: { name: "asc" as const } }, { name: "asc" as const }],
    }),
    prisma.graphProperty.count({ where }),
  ]);

  return { data: properties, total, limit: Number(limit), offset: Number(offset) };
}

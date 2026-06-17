import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

import { getGraphNodeForSite, getGraphPropertyForSite, getGraphPropertySiteId, graphNodeSiteWhere } from "./scope.js";
import { publishGraphDefinitionEvent } from "./definition-events.js";
import { errorResult, type GraphScope, type ListResult, type ServiceResult } from "./types.js";
import { isRecordResolver, validateAcyclicStaticEdges, validateResolverConfig } from "./validation.js";
import { fieldBindingPath, recordModelFromMeta } from "./records.js";

export interface CreateGraphPropertyInput {
  nodeId: string;
  name?: string;
  schemaFieldId?: string | null;
  resolverType?: string;
  resolver?: Record<string, unknown>;
  sampleRateMs?: number | null;
}

export interface UpdateGraphPropertyInput {
  name?: string;
  schemaFieldId?: string | null;
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

function documentEntityResolver(args: { schemaId: string; documentId: string; schemaFieldId: string; path: string }) {
  return {
    type: "entity",
    backend: "jsonb",
    schemaId: args.schemaId,
    documentId: args.documentId,
    schemaFieldId: args.schemaFieldId,
    path: args.path,
  };
}

function recordEntityResolver(args: {
  schemaId: string;
  recordId: string;
  recordModel: string;
  schemaFieldId: string;
  path: string;
}) {
  return {
    type: "entity",
    backend: "record",
    schemaId: args.schemaId,
    recordId: args.recordId,
    recordModel: args.recordModel,
    schemaFieldId: args.schemaFieldId,
    path: args.path,
  };
}

async function resolveSchemaField(args: { schemaFieldId?: string | null; node: { schemaId: string | null } }) {
  if (!args.schemaFieldId) return { data: null };
  if (!args.node.schemaId) return errorResult("NODE_SCHEMA_REQUIRED", "Graph node has no schema for schemaFieldId");
  const field = await prisma.objectSchemaField.findUnique({ where: { id: args.schemaFieldId } });
  if (!field || field.isDeleted) return errorResult("SCHEMA_FIELD_NOT_FOUND", "Schema field not found");
  if (field.schemaId !== args.node.schemaId)
    return errorResult("SCHEMA_FIELD_MISMATCH", "Schema field does not belong to the graph node schema");
  return { data: field };
}

function resolveName(inputName: string | undefined, field: { name: string } | null) {
  const name = inputName !== undefined ? inputName.trim() : field?.name;
  return name?.trim() ? name.trim() : null;
}

async function buildResolver(args: {
  node: {
    schemaId: string | null;
    documentId: string | null;
    recordId: string | null;
    schema?: { meta: unknown } | null;
  };
  field: { id: string; name: string; config: unknown } | null;
  resolverType?: string;
  resolver?: Record<string, unknown>;
  scope: GraphScope;
}) {
  let resolverType = args.resolverType;
  let resolver = args.resolver;

  if (!resolver && args.field && args.node.schemaId && args.node.documentId) {
    resolverType = "entity";
    resolver = documentEntityResolver({
      schemaId: args.node.schemaId,
      documentId: args.node.documentId,
      schemaFieldId: args.field.id,
      path: fieldBindingPath(args.field),
    });
  } else if (!resolver && args.field && args.node.schemaId && args.node.recordId) {
    const recordModel = recordModelFromMeta(args.node.schema?.meta);
    if (!recordModel) return errorResult("INVALID_SCHEMA_META", "RECORD schema meta must include record.model");
    resolverType = "entity";
    resolver = recordEntityResolver({
      schemaId: args.node.schemaId,
      recordId: args.node.recordId,
      recordModel,
      schemaFieldId: args.field.id,
      path: fieldBindingPath(args.field),
    });
  }

  if (!resolverType || !resolver || !isRecordResolver(resolver)) {
    return errorResult(
      "RESOLVER_REQUIRED",
      "resolverType and resolver are required unless schemaFieldId can infer a document- or record-backed resolver",
    );
  }

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
  const node = nodeResult.data;

  const fieldResult = await resolveSchemaField({ schemaFieldId: input.schemaFieldId, node });
  if ("error" in fieldResult) return fieldResult;
  const field = fieldResult.data;

  const name = resolveName(input.name, field);
  if (!name) return errorResult("INVALID_NAME", "Graph property name is required");

  const sampleRateError = validateSampleRate(input.sampleRateMs);
  if (sampleRateError) return sampleRateError;

  const existing = await prisma.graphProperty.findUnique({ where: { nodeId_name: { nodeId: input.nodeId, name } } });
  if (existing && !existing.isDeleted)
    return errorResult("GRAPH_PROPERTY_NAME_EXISTS", "Graph property name already exists on this node");

  const resolverResult = await buildResolver({
    node,
    field,
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
            schemaFieldId: field?.id ?? null,
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
            schemaFieldId: field?.id ?? null,
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
  const node = current.node;

  const fieldResult = await resolveSchemaField({
    schemaFieldId: input.schemaFieldId !== undefined ? input.schemaFieldId : current.schemaFieldId,
    node,
  });
  if ("error" in fieldResult) return fieldResult;
  const field = fieldResult.data;

  const name = resolveName(input.name ?? current.name, field);
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
    node,
    field,
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
        schemaFieldId: field?.id ?? null,
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

export async function validate(
  input: ValidateGraphPropertyInput,
  scope: GraphScope,
): Promise<ServiceResult<unknown>> {
  const nodeResult = await getGraphNodeForSite(input.nodeId, scope);
  if (!nodeResult) return errorResult("GRAPH_NODE_NOT_FOUND", "Graph node not found");
  if ("error" in nodeResult) return nodeResult;
  const node = nodeResult.data;

  const fieldResult = await resolveSchemaField({ schemaFieldId: input.schemaFieldId, node });
  if ("error" in fieldResult) return fieldResult;
  const field = fieldResult.data;

  const resolverResult = await buildResolver({
    node,
    field,
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
      include: { node: { select: { id: true, name: true, siteId: true, schemaId: true, documentId: true, recordId: true } } },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: [{ node: { name: "asc" as const } }, { name: "asc" as const }],
    }),
    prisma.graphProperty.count({ where }),
  ]);

  return { data: properties, total, limit: Number(limit), offset: Number(offset) };
}

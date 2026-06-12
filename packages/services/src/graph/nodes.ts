import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

import { errorResult, type GraphScope, type ListResult, type ServiceResult } from "./types.js";
import {
  graphNodeInclude,
  graphNodeSiteWhere,
  getGraphNodeForSite,
  getGraphNodeSiteId,
  getGraphSiteForWorkspace,
} from "./scope.js";

export interface CreateGraphNodeInput {
  name: string;
  schemaId?: string;
  objectInstanceId?: string;
  materializeFields?: boolean;
}

export interface UpdateGraphNodeInput {
  name?: string;
  schemaId?: string | null;
  objectInstanceId?: string | null;
}

export interface ListGraphNodesFilter {
  schemaId?: string;
  objectInstanceId?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

async function resolveBinding(
  input: { schemaId?: string | null; objectInstanceId?: string | null },
  scope: GraphScope,
) {
  if (input.objectInstanceId) {
    const instance = await prisma.objectInstance.findUnique({
      where: { id: input.objectInstanceId },
      include: { schema: true },
    });
    if (!instance || instance.isDeleted || instance.schema.isDeleted) {
      return errorResult("OBJECT_INSTANCE_NOT_FOUND", "Object instance not found");
    }
    if (instance.schema.workspaceId !== scope.workspaceId) {
      return errorResult("WORKSPACE_MISMATCH", "Object instance does not belong to this workspace");
    }
    if (input.schemaId && input.schemaId !== instance.schemaId) {
      return errorResult("SCHEMA_INSTANCE_MISMATCH", "Graph node schema must match the object instance schema");
    }
    return { data: { schemaId: instance.schemaId, objectInstanceId: instance.id } };
  }

  if (!input.schemaId)
    return errorResult("SCHEMA_REQUIRED", "Graph nodes created through the API require schemaId or objectInstanceId");
  const schema = await prisma.objectSchema.findUnique({ where: { id: input.schemaId } });
  if (!schema || schema.isDeleted) return errorResult("SCHEMA_NOT_FOUND", "Schema not found");
  if (schema.workspaceId !== scope.workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Schema does not belong to this workspace");
  return { data: { schemaId: schema.id, objectInstanceId: null } };
}

function entityResolver(args: { schemaId: string; objectInstanceId: string; schemaFieldId: string; path: string }) {
  return {
    type: "entity",
    backend: "jsonb",
    schemaId: args.schemaId,
    objectInstanceId: args.objectInstanceId,
    schemaFieldId: args.schemaFieldId,
    path: args.path,
  };
}

async function materializeFields(nodeId: string, schemaId: string, objectInstanceId: string): Promise<number> {
  const fields = await prisma.objectSchemaField.findMany({
    where: { schemaId, isDeleted: false },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  for (const field of fields) {
    await prisma.graphProperty.upsert({
      where: { nodeId_name: { nodeId, name: field.name } },
      create: {
        nodeId,
        name: field.name,
        schemaFieldId: field.id,
        resolverType: "entity",
        resolver: entityResolver({
          schemaId,
          objectInstanceId,
          schemaFieldId: field.id,
          path: field.name,
        }) as Prisma.InputJsonValue,
      },
      update: {
        schemaFieldId: field.id,
        resolverType: "entity",
        resolver: entityResolver({
          schemaId,
          objectInstanceId,
          schemaFieldId: field.id,
          path: field.name,
        }) as Prisma.InputJsonValue,
        isDeleted: false,
      },
    });
  }

  return fields.length;
}

export async function create(input: CreateGraphNodeInput, scope: GraphScope): Promise<ServiceResult<unknown>> {
  const name = input.name.trim();
  if (!name) return errorResult("INVALID_NAME", "Graph node name is required");

  const siteResult = await getGraphSiteForWorkspace(scope.siteId, scope.workspaceId);
  if ("error" in siteResult) return siteResult;

  const binding = await resolveBinding(input, scope);
  if ("error" in binding) return binding;

  const existing = await prisma.graphNode.findUnique({ where: { siteId_name: { siteId: scope.siteId, name } } });
  if (existing && !existing.isDeleted) return errorResult("GRAPH_NODE_NAME_EXISTS", "Graph node name already exists");

  const node = await prisma.$transaction(async (tx) => {
    const next = existing
      ? await tx.graphNode.update({
          where: { id: existing.id },
          data: {
            name,
            siteId: scope.siteId,
            schemaId: binding.data.schemaId,
            objectInstanceId: binding.data.objectInstanceId,
            isDeleted: false,
          },
        })
        : await tx.graphNode.create({
            data: { name, siteId: scope.siteId, schemaId: binding.data.schemaId, objectInstanceId: binding.data.objectInstanceId },
          });
    return next;
  });

  if (input.materializeFields && binding.data.objectInstanceId) {
    await materializeFields(node.id, binding.data.schemaId, binding.data.objectInstanceId);
  }

  const created = await prisma.graphNode.findUnique({ where: { id: node.id }, include: graphNodeInclude });
  return { data: created };
}

export async function list(filter: ListGraphNodesFilter, scope: GraphScope): Promise<ListResult<unknown>> {
  const { schemaId, objectInstanceId, name, limit = 50, offset = 0 } = filter;
  const where = {
    ...graphNodeSiteWhere(scope),
    ...(schemaId ? { schemaId } : {}),
    ...(objectInstanceId ? { objectInstanceId } : {}),
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

  if (input.schemaId !== undefined || input.objectInstanceId !== undefined) {
    const binding = await resolveBinding(
      {
        schemaId: input.schemaId !== undefined ? input.schemaId : current.schemaId,
        objectInstanceId: input.objectInstanceId !== undefined ? input.objectInstanceId : current.objectInstanceId,
      },
      scope,
    );
    if ("error" in binding) return binding;

    if (binding.data.schemaId !== current.schemaId) {
      const boundPropertyCount = await prisma.graphProperty.count({
        where: { nodeId: id, isDeleted: false, schemaFieldId: { not: null } },
      });
      if (boundPropertyCount > 0) {
        return errorResult("NODE_SCHEMA_IN_USE", "Cannot change schema while schema-backed properties exist");
      }
    }

    updateData.schemaId = binding.data.schemaId;
    updateData.objectInstanceId = binding.data.objectInstanceId;
  }

  const node = await prisma.graphNode.update({ where: { id }, data: updateData, include: graphNodeInclude });
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
    if (externalDependentCount > 0) {
      return errorResult("GRAPH_NODE_HAS_EXTERNAL_DEPENDENTS", "Cannot delete a node with properties used by other nodes");
    }
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

  return { data: { success: true } };
}

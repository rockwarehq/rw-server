import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

import { errorResult, type GraphScope, type ListResult, type ServiceResult } from "./types.js";
import { publishGraphDefinitionEvent } from "./definition-events.js";
import {
  graphNodeInclude,
  graphNodeSiteWhere,
  getGraphNodeForSite,
  getGraphNodeSiteId,
  getGraphSiteForWorkspace,
} from "./scope.js";
import { assertRecordInSite, fieldBindingPath } from "./records.js";

export interface CreateGraphNodeInput {
  name: string;
  schemaId?: string;
  documentId?: string;
  recordId?: string;
  materializeFields?: boolean;
}

export interface UpdateGraphNodeInput {
  name?: string;
  schemaId?: string | null;
  documentId?: string | null;
  recordId?: string | null;
}

export interface ListGraphNodesFilter {
  schemaId?: string;
  documentId?: string;
  recordId?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

// TODO: redo this
async function resolveBinding(
  input: {
    schemaId?: string | null;
    documentId?: string | null;
    recordId?: string | null;
  },
  scope: GraphScope,
) {
  if (!input.documentId && !input.schemaId && !input.recordId)
    return {
      data: {
        schemaId: null,
        documentId: null,
        recordId: null,
        recordModel: null,
      },
    };

  if (input.documentId && input.recordId) {
    return errorResult("INVALID_BINDING", "Graph node cannot bind to both documentId and recordId");
  }

  if (input.documentId) {
    const document = await prisma.objectInstance.findUnique({
      where: { id: input.documentId },
      include: { schema: true },
    });
    if (!document || document.isDeleted || document.schema.isDeleted) {
      return errorResult("DOCUMENT_NOT_FOUND", "Document not found");
    }
    if (document.schema.source !== "DOCUMENT") {
      return errorResult("INVALID_SCHEMA_SOURCE", "documentId must reference a DOCUMENT schema");
    }
    if (document.schema.workspaceId !== scope.workspaceId || document.schema.siteId !== scope.siteId || document.siteId !== scope.siteId) {
      return errorResult("SITE_MISMATCH", "Document does not belong to this site");
    }
    if (input.schemaId && input.schemaId !== document.schemaId) {
      return errorResult("SCHEMA_DOCUMENT_MISMATCH", "Graph node schema must match the document schema");
    }
    return {
      data: {
        schemaId: document.schemaId,
        documentId: document.id,
        recordId: null,
        recordModel: null,
      },
    };
  }

  if (input.recordId) {
    if (input.schemaId) {
      return errorResult("INVALID_BINDING", "recordId no longer binds through an object schema");
    }
    const recordError = await assertRecordInSite("Site", input.recordId, scope);
    if (recordError) return recordError;
    return {
      data: {
        schemaId: null,
        documentId: null,
        recordId: input.recordId,
        recordModel: "Site",
      },
    };
  }

  if (!input.schemaId) {
    return {
      data: {
        schemaId: null,
        documentId: null,
        recordId: null,
        recordModel: null,
      },
    };
  }

  const schema = await prisma.objectSchema.findUnique({
    where: { id: input.schemaId },
  });
  if (!schema || schema.isDeleted) return errorResult("SCHEMA_NOT_FOUND", "Schema not found");
  if (schema.workspaceId !== scope.workspaceId || schema.siteId !== scope.siteId)
    return errorResult("SITE_MISMATCH", "Schema does not belong to this site");
  if (schema.source !== "DOCUMENT")
    return errorResult("INVALID_SCHEMA_SOURCE", "Graph node schema must be user-authored");
  return {
    data: {
      schemaId: schema.id,
      documentId: null,
      recordId: null,
      recordModel: null,
    },
  };
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

async function materializeFields(
  nodeId: string,
  binding: {
    schemaId: string;
    documentId: string | null;
    recordId: string | null;
    recordModel: string | null;
  },
): Promise<number> {
  const fields = await prisma.objectSchemaField.findMany({
    where: { schemaId: binding.schemaId, isDeleted: false },
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
  });

  for (const field of fields) {
    const path = fieldBindingPath(field);
    const resolver = binding.documentId
      ? documentEntityResolver({
          schemaId: binding.schemaId,
          documentId: binding.documentId,
          schemaFieldId: field.id,
          path,
        })
      : null;
    if (!resolver) continue;

    await prisma.graphProperty.upsert({
      where: { nodeId_name: { nodeId, name: field.key } },
      create: {
        nodeId,
        name: field.key,
        schemaFieldId: field.id,
        resolverType: "entity",
        resolver: resolver as Prisma.InputJsonValue,
      },
      update: {
        schemaFieldId: field.id,
        resolverType: "entity",
        resolver: resolver as Prisma.InputJsonValue,
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

  const existing = await prisma.graphNode.findUnique({
    where: { siteId_name: { siteId: scope.siteId, name } },
  });
  if (existing && !existing.isDeleted) return errorResult("GRAPH_NODE_NAME_EXISTS", "Graph node name already exists");

  const node = await prisma.$transaction(async (tx) => {
    const next = existing
      ? await tx.graphNode.update({
          where: { id: existing.id },
          data: {
            name,
            siteId: scope.siteId,
            schemaId: binding.data.schemaId,
            documentId: binding.data.documentId,
            recordId: binding.data.recordId,
            isDeleted: false,
          },
        })
      : await tx.graphNode.create({
          data: {
            name,
            siteId: scope.siteId,
            schemaId: binding.data.schemaId,
            documentId: binding.data.documentId,
            recordId: binding.data.recordId,
          },
        });
    return next;
  });

  if (input.materializeFields && binding.data.schemaId && binding.data.documentId) {
    await materializeFields(node.id, {
      schemaId: binding.data.schemaId,
      documentId: binding.data.documentId,
      recordId: null,
      recordModel: null,
    });
  }

  const created = await prisma.graphNode.findUnique({
    where: { id: node.id },
    include: graphNodeInclude,
  });
  publishGraphDefinitionEvent({
    entity: "node",
    action: "created",
    entityId: node.id,
    siteId: scope.siteId,
  });
  return { data: created };
}

export async function list(filter: ListGraphNodesFilter, scope: GraphScope): Promise<ListResult<unknown>> {
  const { schemaId, documentId, recordId, name, limit = 50, offset = 0 } = filter;
  const where = {
    ...graphNodeSiteWhere(scope),
    ...(schemaId ? { schemaId } : {}),
    ...(documentId ? { documentId } : {}),
    ...(recordId ? { recordId } : {}),
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
      const conflict = await prisma.graphNode.findUnique({
        where: { siteId_name: { siteId: scope.siteId, name } },
      });
      if (conflict) return errorResult("GRAPH_NODE_NAME_EXISTS", "Graph node name already exists");
    }
    updateData.name = name;
  }

  if (input.schemaId !== undefined || input.documentId !== undefined || input.recordId !== undefined) {
    const binding = await resolveBinding(
      {
        schemaId: input.schemaId !== undefined ? input.schemaId : current.schemaId,
        documentId: input.documentId !== undefined ? input.documentId : current.documentId,
        recordId: input.recordId !== undefined ? input.recordId : current.recordId,
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
    updateData.documentId = binding.data.documentId;
    updateData.recordId = binding.data.recordId;
  }

  const node = await prisma.graphNode.update({
    where: { id },
    data: updateData,
    include: graphNodeInclude,
  });
  publishGraphDefinitionEvent({
    entity: "node",
    action: "updated",
    entityId: id,
    siteId: scope.siteId,
  });
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
        toProperty: {
          isDeleted: false,
          node: { ...graphNodeSiteWhere(scope), id: { not: id } },
        },
      },
    });
    if (externalDependentCount > 0) {
      return errorResult(
        "GRAPH_NODE_HAS_EXTERNAL_DEPENDENTS",
        "Cannot delete a node with properties used by other nodes",
      );
    }
  }

  await prisma.$transaction([
    ...(propertyIds.length > 0
      ? [
          prisma.graphEdge.deleteMany({
            where: {
              OR: [{ fromPropertyId: { in: propertyIds } }, { toPropertyId: { in: propertyIds } }],
            },
          }),
        ]
      : []),
    prisma.graphProperty.updateMany({
      where: { nodeId: id },
      data: { isDeleted: true },
    }),
    prisma.graphNode.update({ where: { id }, data: { isDeleted: true } }),
  ]);

  publishGraphDefinitionEvent({
    entity: "node",
    action: "deleted",
    entityId: id,
    siteId: scope.siteId,
  });

  return { data: { success: true } };
}

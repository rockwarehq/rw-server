import prisma from "@rw/db";

import { errorResult } from "./types.js";

export const graphNodeWorkspaceWhere = (workspaceId: string) => ({
  isDeleted: false,
  OR: [
    { schema: { workspaceId, isDeleted: false } },
    { objectInstance: { schema: { workspaceId, isDeleted: false } } },
  ],
});

export const graphNodeInclude = {
  schema: { select: { id: true, name: true, workspaceId: true, isDeleted: true } },
  objectInstance: {
    select: {
      id: true,
      name: true,
      schemaId: true,
      isDeleted: true,
      schema: { select: { id: true, name: true, workspaceId: true, isDeleted: true } },
    },
  },
  properties: {
    where: { isDeleted: false },
    orderBy: { name: "asc" as const },
  },
};

export function nodeBelongsToWorkspace(
  node: {
    schema?: { workspaceId: string | null; isDeleted: boolean } | null;
    objectInstance?: { isDeleted: boolean; schema?: { workspaceId: string | null; isDeleted: boolean } | null } | null;
  },
  workspaceId: string,
): boolean {
  if (node.schema && !node.schema.isDeleted && node.schema.workspaceId === workspaceId) return true;
  const instanceSchema = node.objectInstance?.schema;
  return Boolean(
    node.objectInstance &&
      !node.objectInstance.isDeleted &&
      instanceSchema &&
      !instanceSchema.isDeleted &&
      instanceSchema.workspaceId === workspaceId,
  );
}

export async function getGraphNodeForWorkspace(id: string, workspaceId: string) {
  const node = await prisma.graphNode.findUnique({ where: { id }, include: graphNodeInclude });
  if (!node) return null;
  if (!nodeBelongsToWorkspace(node, workspaceId))
    return errorResult("WORKSPACE_MISMATCH", "Graph node does not belong to this workspace");
  if (node.isDeleted) return errorResult("GRAPH_NODE_DELETED", "Graph node has been deleted");
  return { data: node };
}

export async function getGraphPropertyForWorkspace(id: string, workspaceId: string) {
  const property = await prisma.graphProperty.findUnique({
    where: { id },
    include: { node: { include: graphNodeInclude } },
  });
  if (!property) return null;
  if (!nodeBelongsToWorkspace(property.node, workspaceId))
    return errorResult("WORKSPACE_MISMATCH", "Graph property does not belong to this workspace");
  if (property.isDeleted || property.node.isDeleted)
    return errorResult("GRAPH_PROPERTY_DELETED", "Graph property has been deleted");
  return { data: property };
}

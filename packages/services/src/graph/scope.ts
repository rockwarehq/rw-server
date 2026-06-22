import prisma from "@rw/db";

import { errorResult, type GraphScope } from "./types.js";

export const graphNodeSiteWhere = (scope: GraphScope) => ({
  isDeleted: false,
  siteId: scope.siteId,
  site: { workspaceId: scope.workspaceId },
});

export const graphNodeInclude = {
  site: { select: { id: true, name: true, workspaceId: true } },
  schema: {
    select: {
      id: true,
      key: true,
      label: true,
      name: true,
      source: true,
      meta: true,
      workspaceId: true,
      siteId: true,
      isSystem: true,
      isDeleted: true,
    },
  },
  document: {
    select: {
      id: true,
      name: true,
      schemaId: true,
      isDeleted: true,
      schema: {
        select: {
          id: true,
          key: true,
          label: true,
          name: true,
          source: true,
          workspaceId: true,
          siteId: true,
          isSystem: true,
          isDeleted: true,
        },
      },
    },
  },
  properties: {
    where: { isDeleted: false },
    orderBy: { name: "asc" as const },
  },
};

export function nodeBelongsToSite(
  node: {
    siteId?: string | null;
    site?: { workspaceId: string | null } | null;
  },
  scope: GraphScope,
): boolean {
  return node.siteId === scope.siteId && node.site?.workspaceId === scope.workspaceId;
}

export async function getGraphSiteForWorkspace(siteId: string, workspaceId: string) {
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) return errorResult("SITE_NOT_FOUND", "Site not found");
  if (site.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Site does not belong to this workspace");
  return { data: site };
}

export async function getGraphNodeSiteId(id: string, workspaceId: string) {
  const node = await prisma.graphNode.findUnique({ where: { id }, include: { site: true } });
  if (!node) return null;
  if (node.site.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Graph node does not belong to this workspace");
  if (node.isDeleted) return errorResult("GRAPH_NODE_DELETED", "Graph node has been deleted");
  return { data: node.siteId };
}

export async function getGraphPropertySiteId(id: string, workspaceId: string) {
  const property = await prisma.graphProperty.findUnique({
    where: { id },
    include: { node: { include: { site: true } } },
  });
  if (!property) return null;
  if (property.node.site.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Graph property does not belong to this workspace");
  if (property.isDeleted || property.node.isDeleted)
    return errorResult("GRAPH_PROPERTY_DELETED", "Graph property has been deleted");
  return { data: property.node.siteId };
}

export async function getGraphNodeForSite(id: string, scope: GraphScope) {
  const node = await prisma.graphNode.findUnique({ where: { id }, include: graphNodeInclude });
  if (!node) return null;
  if (!nodeBelongsToSite(node, scope)) return errorResult("SITE_MISMATCH", "Graph node does not belong to this site");
  if (node.isDeleted) return errorResult("GRAPH_NODE_DELETED", "Graph node has been deleted");
  return { data: node };
}

export async function getGraphPropertyForSite(id: string, scope: GraphScope) {
  const property = await prisma.graphProperty.findUnique({
    where: { id },
    include: { node: { include: graphNodeInclude } },
  });
  if (!property) return null;
  if (!nodeBelongsToSite(property.node, scope))
    return errorResult("SITE_MISMATCH", "Graph property does not belong to this site");
  if (property.isDeleted || property.node.isDeleted)
    return errorResult("GRAPH_PROPERTY_DELETED", "Graph property has been deleted");
  return { data: property };
}

import type { PrismaClient } from "@rw/db";

import { relationTarget } from "./entityCatalog.js";
import type { GraphKernel } from "./kernel.js";
import { isRollupResolverConfig, type GraphEdgeRuntime, type LivestoreLogger } from "./types.js";

interface ChildRow {
  id: string;
}
interface UniqueDelegate {
  findUnique(args: { where: { id: string }; select: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
}

function delegateName(entityType: string): string {
  return entityType.charAt(0).toLowerCase() + entityType.slice(1);
}

// Resolve props with rollup resolvers into edge
export async function buildRollupEdges(
  prisma: PrismaClient,
  kernel: GraphKernel,
  logger: LivestoreLogger,
): Promise<GraphEdgeRuntime[]> {
  // (entityType|entityId) -> nodeId, and nodeId -> entity binding, for instance lookups.
  const nodeByEntity = new Map<string, string>();
  const entityByNode = new Map<string, { entityType: string; entityId: string }>();
  for (const node of kernel.listNodes()) {
    if (!node.entityType || !node.entityId) continue;
    nodeByEntity.set(`${node.entityType}|${node.entityId}`, node.id);
    entityByNode.set(node.id, { entityType: node.entityType, entityId: node.entityId });
  }
  // (nodeId|propertyName) -> propertyId
  const propByNodeName = new Map<string, string>();
  for (const prop of kernel.listProperties()) propByNodeName.set(`${prop.nodeId}|${prop.name}`, prop.id);

  const edges: GraphEdgeRuntime[] = [];

  for (const rollup of kernel.listProperties()) {
    const resolver = rollup.resolver;
    if (!isRollupResolverConfig(resolver)) continue;

    const parent = entityByNode.get(rollup.nodeId);
    if (!parent) continue; // rollup on a non-entity-bound node — nothing to traverse

    // Validate the relation against the catalog (§18.6): it must point to childKind.
    const target = relationTarget(parent.entityType, resolver.relation);
    if (target !== resolver.childKind) {
      logger.warn(
        { propertyId: rollup.id, relation: resolver.relation, expected: resolver.childKind, got: target ?? null },
        "livestore rollup relation does not resolve to childKind in catalog; skipping",
      );
      continue;
    }

    const delegate = (prisma as unknown as Record<string, UniqueDelegate | undefined>)[delegateName(parent.entityType)];
    if (!delegate) continue;
    const row = await delegate.findUnique({
      where: { id: parent.entityId },
      select: { [resolver.relation]: { select: { id: true } } },
    });
    const children = (row?.[resolver.relation] as ChildRow[] | undefined) ?? [];

    for (const child of children) {
      const childNodeId = nodeByEntity.get(`${resolver.childKind}|${child.id}`);
      if (!childNodeId) continue;
      const childPropertyId = propByNodeName.get(`${childNodeId}|${resolver.childProperty}`);
      if (!childPropertyId) continue;
      edges.push({ id: `rollup:${childPropertyId}:${rollup.id}`, fromPropertyId: childPropertyId, toPropertyId: rollup.id });
    }
  }

  logger.info({ rollupEdges: edges.length }, "livestore rollup membership resolved");
  return edges;
}

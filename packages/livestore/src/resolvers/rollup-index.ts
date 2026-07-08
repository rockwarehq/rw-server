import type { PrismaClient } from "@rw/db";
import { systemRelationTargets } from "@rw/services/entity/registry";

import type { GraphKernel } from "../engine/kernel.js";
import {
  isMetricResolver,
  isRollupResolverConfig,
  type GraphEdgeRuntime,
  type LivestoreLogger,
} from "../value/types.js";

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
  // (entityType|entityId) -> nodeId. Source identity lives on property resolvers,
  // not GraphNode; metric leaf and rollup parent resolvers both expose it.
  const nodeByEntity = new Map<string, string>();
  for (const property of kernel.listProperties()) {
    const resolver = property.resolver;
    if (isMetricResolver(resolver)) {
      nodeByEntity.set(`${resolver.entityType}|${resolver.entityId}`, property.nodeId);
    } else if (isRollupResolverConfig(resolver) && resolver.parent) {
      nodeByEntity.set(`${resolver.parent.model}|${resolver.parent.id}`, property.nodeId);
    }
  }
  // (nodeId|propertyName) -> propertyId
  const propByNodeName = new Map<string, string>();
  for (const prop of kernel.listProperties()) propByNodeName.set(`${prop.nodeId}|${prop.name}`, prop.id);

  const relationTargets = systemRelationTargets();
  const edges: GraphEdgeRuntime[] = [];

  for (const rollup of kernel.listProperties()) {
    const resolver = rollup.resolver;
    if (!isRollupResolverConfig(resolver)) continue;

    const parent = resolver.parent;
    if (!parent) continue; // rollup has no explicit source scope — nothing to traverse

    // Validate the relation against the catalog (§18.6): it must point to childKind.
    const target = relationTargets.get(parent.model)?.get(resolver.relation);
    if (target !== resolver.childKind) {
      logger.warn(
        { propertyId: rollup.id, relation: resolver.relation, expected: resolver.childKind, got: target ?? null },
        "livestore rollup relation does not resolve to childKind in catalog; skipping",
      );
      continue;
    }

    const delegate = (prisma as unknown as Record<string, UniqueDelegate | undefined>)[delegateName(parent.model)];
    if (!delegate) continue;
    const row = await delegate.findUnique({
      where: { id: parent.id },
      select: { [resolver.relation]: { select: { id: true } } },
    });
    const children = (row?.[resolver.relation] as ChildRow[] | undefined) ?? [];

    for (const child of children) {
      const childNodeId = nodeByEntity.get(`${resolver.childKind}|${child.id}`);
      if (!childNodeId) continue;
      const childPropertyId = propByNodeName.get(`${childNodeId}|${resolver.childProperty}`);
      if (!childPropertyId) continue;
      edges.push({
        id: `rollup:${childPropertyId}:${rollup.id}`,
        fromPropertyId: childPropertyId,
        toPropertyId: rollup.id,
      });
      // weight changes must re-trigger the rollup too (§18.2)
      if (resolver.aggregation === "avg" && resolver.weightBy) {
        const weightPropertyId = propByNodeName.get(`${childNodeId}|${resolver.weightBy}`);
        if (weightPropertyId) {
          edges.push({
            id: `rollup:${weightPropertyId}:${rollup.id}`,
            fromPropertyId: weightPropertyId,
            toPropertyId: rollup.id,
          });
        }
      }
    }
  }

  logger.info({ rollupEdges: edges.length }, "livestore rollup membership resolved");
  return edges;
}

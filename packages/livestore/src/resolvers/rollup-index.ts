import type { PrismaClient } from "@rw/db";
import { systemRelationTargets } from "@rw/services/entity/registry";

import type { GraphKernel } from "../engine/kernel.js";
import {
  isMetricResolver,
  isRollupResolverConfig,
  type GraphEdgeRuntime,
  type LivestoreLogger,
} from "../types/index.js";

interface ChildRow {
  id: string;
}
interface ManyDelegate {
  findMany(args: {
    where: { id: { in: string[] } };
    select: Record<string, unknown>;
  }): Promise<Array<Record<string, unknown>>>;
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

  // First pass: keep rollups whose relation validates against the catalog, and
  // group their parent ids by (model, relation) so each group is one query.
  const validRollups = kernel.listProperties().filter((rollup) => {
    const resolver = rollup.resolver;
    if (!isRollupResolverConfig(resolver) || !resolver.parent) return false;
    const target = relationTargets.get(resolver.parent.model)?.get(resolver.relation);
    if (target !== resolver.childKind) {
      logger.warn(
        { propertyId: rollup.id, relation: resolver.relation, expected: resolver.childKind, got: target ?? null },
        "livestore rollup relation does not resolve to childKind in catalog; skipping",
      );
      return false;
    }
    return true;
  });

  // (model|relation) -> set of parent ids. Batching collapses one findUnique per
  // rollup property into one findMany per distinct (model, relation) pair —
  // this runs on boot, on entity-event rebuilds, and in the 30s reconcile.
  const parentIdsByGroup = new Map<string, { model: string; relation: string; ids: Set<string> }>();
  for (const rollup of validRollups) {
    const resolver = rollup.resolver;
    if (!isRollupResolverConfig(resolver) || !resolver.parent) continue; // narrowing; already filtered
    const key = `${resolver.parent.model}|${resolver.relation}`;
    const group = parentIdsByGroup.get(key) ?? { model: resolver.parent.model, relation: resolver.relation, ids: new Set<string>() };
    group.ids.add(resolver.parent.id);
    parentIdsByGroup.set(key, group);
  }

  // (model|relation|parentId) -> child rows.
  const childrenByParent = new Map<string, ChildRow[]>();
  for (const group of parentIdsByGroup.values()) {
    const delegate = (prisma as unknown as Record<string, ManyDelegate | undefined>)[delegateName(group.model)];
    if (!delegate) continue;
    const rows = await delegate.findMany({
      where: { id: { in: [...group.ids] } },
      select: { id: true, [group.relation]: { select: { id: true } } },
    });
    for (const row of rows) {
      const parentId = row.id as string;
      childrenByParent.set(`${group.model}|${group.relation}|${parentId}`, (row[group.relation] as ChildRow[] | undefined) ?? []);
    }
  }

  for (const rollup of validRollups) {
    const resolver = rollup.resolver;
    if (!isRollupResolverConfig(resolver) || !resolver.parent) continue;
    const children = childrenByParent.get(`${resolver.parent.model}|${resolver.relation}|${resolver.parent.id}`) ?? [];

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

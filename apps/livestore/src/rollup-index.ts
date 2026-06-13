import type { PrismaClient } from "@rw/db";

import type { GraphKernel } from "./kernel.js";
import { isMetricResolver, isRollupResolverConfig, type GraphEdgeRuntime, type LivestoreLogger } from "./types.js";

interface ChildRow {
  id: string;
}
interface UniqueDelegate {
  findUnique(args: { where: { id: string }; select: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
}

function delegateName(entityType: string): string {
  return entityType.charAt(0).toLowerCase() + entityType.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordModelFromMeta(meta: unknown): string | null {
  if (!isRecord(meta) || !isRecord(meta.record)) return null;
  return typeof meta.record.model === "string" ? meta.record.model : null;
}

async function loadRelationTargets(prisma: PrismaClient): Promise<Map<string, Map<string, string>>> {
  const schemas = await prisma.objectSchema.findMany({
    where: { source: "RECORD", isDeleted: false },
    include: {
      fields: {
        where: { isDeleted: false, type: "OBJECT" },
        include: { refSchema: { select: { meta: true } } },
      },
    },
  });

  const targetsByModel = new Map<string, Map<string, string>>();
  for (const schema of schemas) {
    const model = recordModelFromMeta(schema.meta);
    if (!model) continue;
    const targets = targetsByModel.get(model) ?? new Map<string, string>();
    for (const field of schema.fields) {
      const target = recordModelFromMeta(field.refSchema?.meta);
      if (target) targets.set(field.name, target);
    }
    targetsByModel.set(model, targets);
  }
  return targetsByModel;
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

  const relationTargets = await loadRelationTargets(prisma);
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
    }
  }

  logger.info({ rollupEdges: edges.length }, "livestore rollup membership resolved");
  return edges;
}

import type { PrismaClient } from "@rw/db";

// TEMPORARY: materializes Datasource nodes + tag properties until they are authored from the UI.

export interface DatasourceTagSyncResult {
  nodes: number;
  properties: number;
  pruned: number;
}

export async function syncDatasourceTags(prisma: PrismaClient): Promise<DatasourceTagSyncResult> {
  const datasources = await prisma.datasource.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      name: true,
      site: { select: { name: true } },
      points: { select: { id: true, name: true }, orderBy: { id: "asc" } },
    },
  });

  let nodes = 0;
  let properties = 0;
  let pruned = 0;

  for (const ds of datasources) {
    const nodeName = ds.site ? `${ds.site.name} / ${ds.name}` : ds.name;
    const node = await prisma.graphNode.upsert({
      where: { name: nodeName },
      create: { name: nodeName },
      update: { isDeleted: false },
    });
    nodes += 1;

    // Point.name has no unique constraint per datasource; suffix duplicates with a short id.
    const seen = new Set<string>();
    for (const point of ds.points) {
      const name = seen.has(point.name) ? `${point.name}_${point.id.slice(0, 8)}` : point.name;
      seen.add(name);
      const resolver = { type: "tag", deviceId: ds.id, tagPath: point.id };
      const tagProp = await prisma.graphProperty.upsert({
        where: { nodeId_name: { nodeId: node.id, name } },
        create: { nodeId: node.id, name, resolverType: "tag", resolver },
        update: { resolverType: "tag", resolver, isDeleted: false },
      });
      properties += 1;

      // TEMPORARY: 1m change-count window per tag, for exercising the window resolver.
      const windowName = `${name}_changes_1m`;
      const windowResolver = {
        type: "window",
        sourcePropertyId: tagProp.id,
        kind: "tumbling",
        aggregation: "count",
        windowMs: 60_000,
      };
      await prisma.graphProperty.upsert({
        where: { nodeId_name: { nodeId: node.id, name: windowName } },
        create: { nodeId: node.id, name: windowName, resolverType: "window", resolver: windowResolver },
        update: { resolverType: "window", resolver: windowResolver, isDeleted: false },
      });
      properties += 1;
    }

    // Soft-delete tag props whose point is gone; editor-added (non-tag) props untouched.
    const livePointIds = new Set(ds.points.map((point) => point.id));
    const tagProps = await prisma.graphProperty.findMany({
      where: { nodeId: node.id, resolverType: "tag", isDeleted: false },
      select: { id: true, resolver: true },
    });
    const prunedTagPropIds = new Set<string>();
    for (const prop of tagProps) {
      const tagPath = (prop.resolver as { tagPath?: string } | null)?.tagPath;
      if (typeof tagPath === "string" && !livePointIds.has(tagPath)) {
        await prisma.graphProperty.update({ where: { id: prop.id }, data: { isDeleted: true } });
        prunedTagPropIds.add(prop.id);
        pruned += 1;
      }
    }

    // Windows over a pruned tag prop are orphaned — prune them too.
    if (prunedTagPropIds.size > 0) {
      const windowProps = await prisma.graphProperty.findMany({
        where: { nodeId: node.id, resolverType: "window", isDeleted: false },
        select: { id: true, resolver: true },
      });
      for (const prop of windowProps) {
        const sourceId = (prop.resolver as { sourcePropertyId?: string } | null)?.sourcePropertyId;
        if (typeof sourceId === "string" && prunedTagPropIds.has(sourceId)) {
          await prisma.graphProperty.update({ where: { id: prop.id }, data: { isDeleted: true } });
          pruned += 1;
        }
      }
    }
  }

  return { nodes, properties, pruned };
}

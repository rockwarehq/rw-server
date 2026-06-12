import { describe, expect, it } from "vitest";

import { syncDatasourceTags } from "./datasource-tag-sync.js";

interface FakeArgs {
  datasources: unknown[];
  existingTagProps?: Record<string, { id: string; resolver: unknown }[]>;
  prunedNodeCount?: number;
}

function fakePrisma(args: FakeArgs) {
  const nodeUpserts: Record<string, unknown>[] = [];
  const propUpserts: Record<string, unknown>[] = [];
  const propSoftDeletes: string[] = [];
  let nodePruneWhere: Record<string, unknown> | undefined;

  const prisma = {
    datasource: {
      findMany: async () => args.datasources,
    },
    graphNode: {
      upsert: async (input: { where: { entityType_entityId: { entityId: string } } }) => {
        nodeUpserts.push(input);
        return { id: `node-${input.where.entityType_entityId.entityId}` };
      },
      updateMany: async (input: { where: Record<string, unknown> }) => {
        nodePruneWhere = input.where;
        return { count: args.prunedNodeCount ?? 0 };
      },
    },
    graphProperty: {
      upsert: async (input: Record<string, unknown>) => {
        propUpserts.push(input);
        return { id: "prop" };
      },
      findMany: async (input: { where: { nodeId: string } }) => args.existingTagProps?.[input.where.nodeId] ?? [],
      update: async (input: { where: { id: string } }) => {
        propSoftDeletes.push(input.where.id);
        return {};
      },
    },
  };

  return {
    prisma: prisma as never,
    nodeUpserts,
    propUpserts,
    propSoftDeletes,
    getNodePruneWhere: () => nodePruneWhere,
  };
}

describe("syncDatasourceTags", () => {
  it("materializes a node per datasource and a tag property per point", async () => {
    const { prisma, nodeUpserts, propUpserts } = fakePrisma({
      datasources: [
        {
          id: "ds-1",
          name: "Press PLC",
          site: { name: "Sarasota" },
          points: [
            { id: "p-1", name: "cycleTime" },
            { id: "p-2", name: "cavityCount" },
          ],
        },
      ],
    });

    const result = await syncDatasourceTags(prisma);

    expect(result).toEqual({ nodes: 1, properties: 2, pruned: 0 });
    expect(nodeUpserts[0]).toMatchObject({
      where: { entityType_entityId: { entityType: "Datasource", entityId: "ds-1" } },
      create: { name: "Sarasota / Press PLC", kind: "Datasource" },
    });
    expect(propUpserts[0]).toMatchObject({
      where: { nodeId_name: { nodeId: "node-ds-1", name: "cycleTime" } },
      create: { resolverType: "tag", resolver: { type: "tag", deviceId: "ds-1", tagPath: "p-1" } },
    });
    expect(propUpserts[1]).toMatchObject({
      create: { resolver: { type: "tag", deviceId: "ds-1", tagPath: "p-2" } },
    });
  });

  it("suffixes colliding point names with a short point id", async () => {
    const { prisma, propUpserts } = fakePrisma({
      datasources: [
        {
          id: "ds-1",
          name: "PLC",
          site: null,
          points: [
            { id: "aaaaaaaa-0000-0000-0000-000000000000", name: "temp" },
            { id: "bbbbbbbb-0000-0000-0000-000000000000", name: "temp" },
          ],
        },
      ],
    });

    await syncDatasourceTags(prisma);

    const names = propUpserts.map((u) => (u.where as { nodeId_name: { name: string } }).nodeId_name.name);
    expect(names).toEqual(["temp", "temp_bbbbbbbb"]);
  });

  it("prunes tag properties whose point is gone and nodes whose datasource is gone", async () => {
    const { prisma, propSoftDeletes, getNodePruneWhere } = fakePrisma({
      datasources: [{ id: "ds-1", name: "PLC", site: null, points: [{ id: "p-1", name: "cycleTime" }] }],
      existingTagProps: {
        "node-ds-1": [
          { id: "keep", resolver: { type: "tag", deviceId: "ds-1", tagPath: "p-1" } },
          { id: "stale", resolver: { type: "tag", deviceId: "ds-1", tagPath: "p-deleted" } },
        ],
      },
      prunedNodeCount: 2,
    });

    const result = await syncDatasourceTags(prisma);

    expect(propSoftDeletes).toEqual(["stale"]);
    expect(result.pruned).toBe(3);
    expect(getNodePruneWhere()).toMatchObject({
      entityType: "Datasource",
      isDeleted: false,
      entityId: { notIn: ["ds-1"] },
    });
  });
});

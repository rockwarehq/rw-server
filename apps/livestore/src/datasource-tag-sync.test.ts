import { describe, expect, it } from "vitest";

import { syncDatasourceTags } from "./datasource-tag-sync.js";

interface FakeArgs {
  datasources: unknown[];
  existingProps?: Record<string, { id: string; resolverType: string; resolver: unknown }[]>;
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
      upsert: async (input: { where: { nodeId_name: { name: string } } }) => {
        propUpserts.push(input);
        return { id: `prop-${input.where.nodeId_name.name}` };
      },
      findMany: async (input: { where: { nodeId: string; resolverType: string } }) =>
        (args.existingProps?.[input.where.nodeId] ?? []).filter((p) => p.resolverType === input.where.resolverType),
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

    expect(result).toEqual({ nodes: 1, properties: 4, pruned: 0 });
    expect(nodeUpserts[0]).toMatchObject({
      where: { entityType_entityId: { entityType: "Datasource", entityId: "ds-1" } },
      create: { name: "Sarasota / Press PLC", kind: "Datasource" },
    });
    expect(propUpserts[0]).toMatchObject({
      where: { nodeId_name: { nodeId: "node-ds-1", name: "cycleTime" } },
      create: { resolverType: "tag", resolver: { type: "tag", deviceId: "ds-1", tagPath: "p-1" } },
    });
    expect(propUpserts[1]).toMatchObject({
      where: { nodeId_name: { nodeId: "node-ds-1", name: "cycleTime_changes_1m" } },
      create: {
        resolverType: "window",
        resolver: {
          type: "window",
          sourcePropertyId: "prop-cycleTime",
          kind: "tumbling",
          aggregation: "count",
          windowMs: 60_000,
        },
      },
    });
    expect(propUpserts[2]).toMatchObject({
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
    expect(names).toEqual(["temp", "temp_changes_1m", "temp_bbbbbbbb", "temp_bbbbbbbb_changes_1m"]);
  });

  it("prunes tag properties whose point is gone, their windows, and nodes whose datasource is gone", async () => {
    const { prisma, propSoftDeletes, getNodePruneWhere } = fakePrisma({
      datasources: [{ id: "ds-1", name: "PLC", site: null, points: [{ id: "p-1", name: "cycleTime" }] }],
      existingProps: {
        "node-ds-1": [
          { id: "keep", resolverType: "tag", resolver: { type: "tag", deviceId: "ds-1", tagPath: "p-1" } },
          { id: "stale", resolverType: "tag", resolver: { type: "tag", deviceId: "ds-1", tagPath: "p-deleted" } },
          { id: "keep-window", resolverType: "window", resolver: { type: "window", sourcePropertyId: "keep" } },
          { id: "stale-window", resolverType: "window", resolver: { type: "window", sourcePropertyId: "stale" } },
        ],
      },
      prunedNodeCount: 2,
    });

    const result = await syncDatasourceTags(prisma);

    expect(propSoftDeletes).toEqual(["stale", "stale-window"]);
    expect(result.pruned).toBe(4);
    expect(getNodePruneWhere()).toMatchObject({
      entityType: "Datasource",
      isDeleted: false,
      entityId: { notIn: ["ds-1"] },
    });
  });
});

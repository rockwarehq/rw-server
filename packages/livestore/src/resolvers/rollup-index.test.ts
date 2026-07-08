import type { PrismaClient } from "@rw/db";
import { describe, expect, it, vi } from "vitest";

import type { GraphKernel } from "../engine/kernel.js";
import { buildRollupEdges } from "./rollup-index.js";
import type { GraphResolver, LivestoreLogger, PropertyRuntime } from "../types/index.js";

const logger: LivestoreLogger = { info: () => {}, warn: () => {}, error: () => {} };

function prop(id: string, nodeId: string, name: string, resolver: GraphResolver): PropertyRuntime {
  return {
    id,
    nodeId,
    name,
    resolverType: resolver.type,
    resolver,
    sampleRateMs: null,
    current: { value: null, quality: "stale", timestamp: 0 },
  };
}

const metric = (entityId: string): GraphResolver => ({
  type: "metric",
  entityType: "Station",
  entityId,
  granularity: "shift",
  metricKey: "oee",
});

const rollup = (parentId: string): GraphResolver => ({
  type: "rollup",
  parent: { model: "Workcenter", id: parentId },
  childKind: "Station",
  relation: "stations",
  childProperty: "oee",
  aggregation: "sum",
});

// Kernel double exposing only listProperties (all buildRollupEdges touches).
function kernelWith(properties: PropertyRuntime[]): GraphKernel {
  return { listProperties: () => properties } as unknown as GraphKernel;
}

describe("buildRollupEdges batching", () => {
  it("issues one findMany per (model, relation) group regardless of rollup count", async () => {
    // Two child stations, each with a metric leaf (maps entity->node) and an
    // "oee" child property; two parent workcenters each with a rollup over
    // Workcenter.stations.
    const properties: PropertyRuntime[] = [
      prop("m-st1", "node-st1", "oeeMetric", metric("st1")),
      prop("oee-st1", "node-st1", "oee", { type: "expr", expression: "1" }),
      prop("m-st2", "node-st2", "oeeMetric", metric("st2")),
      prop("oee-st2", "node-st2", "oee", { type: "expr", expression: "1" }),
      prop("rollup-wc1", "node-wc1", "stationOee", rollup("wc1")),
      prop("rollup-wc2", "node-wc2", "stationOee", rollup("wc2")),
    ];

    const findMany = vi.fn(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({
        id,
        stations: id === "wc1" ? [{ id: "st1" }] : [{ id: "st2" }],
      })),
    );
    const prisma = { workcenter: { findMany } } as unknown as PrismaClient;

    const edges = await buildRollupEdges(prisma, kernelWith(properties), logger);

    // Both rollups share (Workcenter, stations) -> a single batched query.
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]![0].where.id.in.sort()).toEqual(["wc1", "wc2"]);

    // wc1 -> st1's oee, wc2 -> st2's oee.
    expect(edges).toContainEqual({ id: "rollup:oee-st1:rollup-wc1", fromPropertyId: "oee-st1", toPropertyId: "rollup-wc1" });
    expect(edges).toContainEqual({ id: "rollup:oee-st2:rollup-wc2", fromPropertyId: "oee-st2", toPropertyId: "rollup-wc2" });
    expect(edges).toHaveLength(2);
  });

  it("skips rollups whose relation does not resolve to childKind in the catalog", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { workcenter: { findMany } } as unknown as PrismaClient;
    const bad = prop("rollup-bad", "node-wc1", "x", {
      type: "rollup",
      parent: { model: "Workcenter", id: "wc1" },
      childKind: "Station",
      relation: "notARelation",
      childProperty: "oee",
      aggregation: "sum",
    });

    const edges = await buildRollupEdges(prisma, kernelWith([bad]), logger);

    expect(edges).toHaveLength(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});

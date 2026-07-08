import type { PrismaClient } from "@rw/db";
import { describe, expect, it } from "vitest";

import type { CvgStore } from "../value/cvg-store.js";
import type { GraphEdgeRuntime, NodeRuntime, PropertyRuntime, ValueEnvelope } from "../value/types.js";
import { GraphKernel } from "./kernel.js";

const logger = { info: () => {}, warn: () => {}, error: () => {} };

// The apply/remove patch paths are pure in-memory: prisma/cvg are only used by
// load()/loadNodeDefinition(), which these tests don't exercise.
function makeKernel(): GraphKernel {
  return new GraphKernel({} as PrismaClient, {} as CvgStore, logger);
}

function node(id: string): NodeRuntime {
  return { id, name: id, siteId: "site-1", typeRef: null, typeContext: {}, propertyIds: [] };
}

function prop(id: string, nodeId: string, overrides: Partial<PropertyRuntime> = {}): PropertyRuntime {
  return {
    id,
    nodeId,
    name: id,
    resolverType: "expr",
    resolver: { type: "expr", expression: "1" },
    sampleRateMs: null,
    current: { value: null, quality: "stale", timestamp: 0 },
    ...overrides,
  };
}

function edge(id: string, from: string, to: string): GraphEdgeRuntime {
  return { id, fromPropertyId: from, toPropertyId: to };
}

describe("applyNodeDefinition", () => {
  it("reports upserts and removals against the previous node state", () => {
    const kernel = makeKernel();
    kernel.applyNodeDefinition({ node: node("n1"), properties: [prop("a", "n1"), prop("b", "n1")], edges: [] });

    const result = kernel.applyNodeDefinition({
      node: node("n1"),
      properties: [prop("a", "n1"), prop("c", "n1")],
      edges: [],
    });

    expect(result.upsertedProperties.map((u) => u.current.id)).toEqual(["a", "c"]);
    expect(result.upsertedProperties.find((u) => u.current.id === "a")?.previous?.id).toBe("a");
    expect(result.removedProperties.map((p) => p.id)).toEqual(["b"]);
    expect(kernel.getProperty("b")).toBeNull();
    expect(kernel.getNode("n1")?.properties.map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("preserves the live current value across a redefinition", () => {
    const kernel = makeKernel();
    kernel.applyNodeDefinition({ node: node("n1"), properties: [prop("a", "n1")], edges: [] });
    const live: ValueEnvelope = { value: 42, quality: "good", timestamp: 1000 };
    kernel.applyExternalValue("a", live);

    kernel.applyNodeDefinition({ node: node("n1"), properties: [prop("a", "n1")], edges: [] });

    expect(kernel.getCurrent("a")).toEqual(live);
  });
});

describe("applyPropertyDefinition", () => {
  it("a property moved between nodes leaves the old node's membership", () => {
    const kernel = makeKernel();
    kernel.applyNodeDefinition({ node: node("n1"), properties: [prop("p1", "n1")], edges: [] });
    kernel.applyNodeDefinition({ node: node("n2"), properties: [], edges: [] });

    kernel.applyPropertyDefinition({ node: node("n2"), property: prop("p1", "n2"), edges: [] });

    expect(kernel.getNode("n1")?.properties).toEqual([]);
    expect(kernel.getNode("n2")?.properties.map((p) => p.id)).toEqual(["p1"]);
  });

  it("replaces incoming persisted edges for the property", () => {
    const kernel = makeKernel();
    kernel.applyNodeDefinition({
      node: node("n1"),
      properties: [prop("src1", "n1"), prop("src2", "n1"), prop("out", "n1")],
      edges: [edge("e1", "src1", "out")],
    });
    expect(kernel.getDependencies("out")).toEqual(["src1"]);

    kernel.applyPropertyDefinition({
      node: node("n1"),
      property: prop("out", "n1"),
      edges: [edge("e2", "src2", "out")],
    });

    expect(kernel.getDependencies("out")).toEqual(["src2"]);
  });
});

describe("removal", () => {
  it("removeNode drops properties, membership, and incident edges", () => {
    const kernel = makeKernel();
    kernel.applyNodeDefinition({ node: node("n1"), properties: [prop("a", "n1")], edges: [] });
    kernel.applyNodeDefinition({
      node: node("n2"),
      properties: [prop("b", "n2")],
      edges: [edge("e1", "a", "b")],
    });
    expect(kernel.getDependents("a")).toEqual(["b"]);

    const result = kernel.removeNode("n2");

    expect(result.removedProperties.map((p) => p.id)).toEqual(["b"]);
    expect(kernel.getNode("n2")).toBeNull();
    expect(kernel.getDependents("a")).toEqual([]);
  });

  it("removeProperty is a no-op for unknown ids", () => {
    const kernel = makeKernel();
    expect(kernel.removeProperty("ghost")).toEqual({ upsertedProperties: [], removedProperties: [] });
  });
});

describe("rollup edges", () => {
  it("a persisted edge coinciding with a rollup edge survives a rollup replace", () => {
    const kernel = makeKernel();
    kernel.applyNodeDefinition({
      node: node("n1"),
      properties: [prop("child", "n1"), prop("parent", "n1")],
      edges: [edge("persisted-1", "child", "parent")],
    });

    kernel.applyRollupEdges([edge("rollup:child:parent", "child", "parent")]);
    expect(kernel.getDependents("child")).toEqual(["parent"]);

    // The rollup goes away; the user-drawn edge must remain in the DAG.
    kernel.applyRollupEdges([]);
    expect(kernel.getDependents("child")).toEqual(["parent"]);
  });
});

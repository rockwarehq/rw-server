import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GraphEdgeRuntime, PropertyRuntime } from "../types/index.js";
import { DependencyGraph } from "./dependency-graph.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function prop(id: string): PropertyRuntime {
  return {
    id,
    nodeId: `node-${id}`,
    name: id,
    resolverType: "expr",
    resolver: { type: "expr", expression: "1" },
    sampleRateMs: null,
    current: { value: null, quality: "stale", timestamp: 0 },
  };
}

function edge(id: string, from: string, to: string): GraphEdgeRuntime {
  return { id, fromPropertyId: from, toPropertyId: to };
}

beforeEach(() => {
  logger.warn.mockClear();
  logger.info.mockClear();
});

describe("cycle quarantine", () => {
  it("excludes cycle members from topo, keeps the rest, and logs the members", () => {
    const graph = new DependencyGraph(logger);
    graph.rebuild(
      [prop("a"), prop("b"), prop("c")],
      [edge("e1", "a", "b"), edge("e2", "b", "a"), edge("e3", "b", "c")],
    );

    expect(graph.isQuarantined("a")).toBe(true);
    expect(graph.isQuarantined("b")).toBe(true);
    expect(graph.isQuarantined("c")).toBe(false);
    expect(graph.topoOrder()).toEqual(["c"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cycles: 1, members: expect.arrayContaining(["a", "b"]) }),
      expect.stringContaining("quarantined"),
    );
  });

  it("releases the quarantine once the cycle is broken", () => {
    const graph = new DependencyGraph(logger);
    graph.rebuild([prop("a"), prop("b")], [edge("e1", "a", "b"), edge("e2", "b", "a")]);
    expect(graph.isQuarantined("a")).toBe(true);

    graph.replaceEdges({ removeEdgeIds: ["e2"], edges: [] });

    expect(graph.isQuarantined("a")).toBe(false);
    expect(graph.isQuarantined("b")).toBe(false);
    expect(graph.topoOrder()).toEqual(["a", "b"]);
  });
});

describe("coincident edges", () => {
  it("removing a rollup edge id keeps a coincident persisted edge", () => {
    const graph = new DependencyGraph(logger);
    graph.rebuild([prop("child"), prop("parent")], [edge("persisted-1", "child", "parent")]);

    // A derived rollup edge lands on the same (from, to) pair.
    graph.replaceEdges({ edges: [edge("rollup-1", "child", "parent")] });
    expect(graph.getDependents("child")).toEqual(["parent"]);

    // Rollup config removed: only the rollup id goes away, the persisted edge survives.
    graph.replaceEdges({ removeEdgeIds: ["rollup-1"], edges: [] });
    expect(graph.getDependents("child")).toEqual(["parent"]);

    // Removing the persisted id too finally drops the pair.
    graph.replaceEdges({ removeEdgeIds: ["persisted-1"], edges: [] });
    expect(graph.getDependents("child")).toEqual([]);
  });

  it("re-adding an existing pair merges edge ids instead of overwriting", () => {
    const graph = new DependencyGraph(logger);
    graph.rebuild([prop("a"), prop("b")], [edge("e1", "a", "b")]);
    graph.replaceEdges({ edges: [edge("e2", "a", "b")] });

    // Removing either id alone keeps the dependency intact.
    graph.replaceEdges({ removeEdgeIds: ["e1"], edges: [] });
    expect(graph.getDependencies("b")).toEqual(["a"]);
  });
});

describe("topo index", () => {
  it("matches the topo order and is undefined for quarantined or unknown ids", () => {
    const graph = new DependencyGraph(logger);
    graph.rebuild(
      [prop("a"), prop("b"), prop("c"), prop("d")],
      [edge("e1", "a", "b"), edge("e2", "c", "d"), edge("e3", "d", "c")],
    );

    const order = graph.topoOrder();
    expect(order).toEqual(["a", "b"]);
    expect(graph.topoIndex("a")).toBe(order.indexOf("a"));
    expect(graph.topoIndex("b")).toBe(order.indexOf("b"));
    expect(graph.topoIndex("c")).toBeUndefined(); // quarantined (c<->d cycle)
    expect(graph.topoIndex("ghost")).toBeUndefined();
  });

  it("recomputes lazily after mutations", () => {
    const graph = new DependencyGraph(logger);
    graph.rebuild([prop("a"), prop("b")], []);
    expect(graph.topoIndex("a")).toBeDefined();

    graph.replaceEdges({ edges: [edge("e1", "b", "a")] });
    const aIndex = graph.topoIndex("a");
    const bIndex = graph.topoIndex("b");
    expect(bIndex).toBeLessThan(aIndex as number);
  });
});

describe("edge replacement", () => {
  it("targetPropertyIds removes all incoming edges of the target before re-adding", () => {
    const graph = new DependencyGraph(logger);
    graph.rebuild([prop("x"), prop("y"), prop("t")], [edge("e1", "x", "t"), edge("e2", "y", "t")]);

    graph.replaceEdges({ targetPropertyIds: ["t"], edges: [edge("e3", "y", "t")] });

    expect(graph.getDependencies("t")).toEqual(["y"]);
    expect(graph.topoOrder().indexOf("y")).toBeLessThan(graph.topoOrder().indexOf("t"));
  });

  it("removeIncidentPropertyIds strips edges touching removed properties", () => {
    const graph = new DependencyGraph(logger);
    graph.rebuild([prop("x"), prop("y"), prop("z")], [edge("e1", "x", "y"), edge("e2", "y", "z")]);
    graph.removeProperties(["y"]);
    graph.replaceEdges({ removeIncidentPropertyIds: ["y"], edges: [] });

    expect(graph.getDependents("x")).toEqual([]);
    expect(graph.getDependencies("z")).toEqual([]);
  });
});

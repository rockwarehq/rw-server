import { describe, expect, it, vi } from "vitest";

const NODE = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Press 1", siteId: "site-1", typeRef: "@imm/station" };
const P_TAG = "11111111-1111-4111-8111-111111111111";
const P_EXPR = "22222222-2222-4222-8222-222222222222";
const P_WINDOW = "33333333-3333-4333-8333-333333333333";

const siteProperties = [
  { id: P_TAG, name: "cycleTime", nodeId: NODE.id, resolverType: "tag", node: { name: NODE.name } },
  { id: P_EXPR, name: "cycleDelta", nodeId: NODE.id, resolverType: "expr", node: { name: NODE.name } },
  { id: P_WINDOW, name: "cycleAvg", nodeId: NODE.id, resolverType: "window", node: { name: NODE.name } },
];

// Chain: P_TAG -> P_EXPR -> P_WINDOW
const edges = [
  { fromPropertyId: P_TAG, toPropertyId: P_EXPR },
  { fromPropertyId: P_EXPR, toPropertyId: P_WINDOW },
];

const hooks = [
  {
    id: "hook-1",
    name: "cycle completed",
    enabled: true,
    condition: { source: { type: "property", propertyId: P_TAG }, operator: "increases" },
    eventContext: { cycleAvg: { source: { type: "property", propertyId: P_WINDOW } } },
  },
];

const aggregate = vi.fn(async () => ({ _max: { updatedAt: new Date("2026-07-08T12:00:00Z") } }));
const count = vi.fn(async () => 1);

vi.mock("@rw/db", () => ({
  default: {
    graphNode: {
      aggregate: (...args: unknown[]) => aggregate(...(args as [])),
      count: (...args: unknown[]) => count(...(args as [])),
      findMany: vi.fn(async () => [
        {
          id: NODE.id,
          name: NODE.name,
          typeRef: NODE.typeRef,
          typeContext: {},
          facets: {},
          properties: [
            { id: P_TAG, name: "cycleTime", typeFieldKey: "totalCycles" },
            { id: P_EXPR, name: "cycleDelta", typeFieldKey: "legacyField" },
          ],
        },
      ]),
    },
    graphProperty: {
      aggregate: (...args: unknown[]) => aggregate(...(args as [])),
      count: (...args: unknown[]) => count(...(args as [])),
      findMany: vi.fn(async ({ select }: { select?: Record<string, unknown> }) =>
        select?.node ? siteProperties : siteProperties.map(({ node: _node, ...rest }) => rest),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const property = siteProperties.find((p) => p.id === where.id);
        if (!property) return null;
        return {
          ...property,
          typeFieldKey: null,
          resolver: { type: property.resolverType },
          sampleRateMs: null,
          isDeleted: false,
          node: {
            id: NODE.id,
            name: NODE.name,
            siteId: "site-1",
            typeRef: NODE.typeRef,
            isDeleted: false,
            site: { id: "site-1", name: "Site", workspaceId: "ws-1" },
            properties: [],
          },
        };
      }),
    },
    graphEdge: {
      count: (...args: unknown[]) => count(...(args as [])),
      findMany: vi.fn(async () => edges),
    },
    graphHook: {
      aggregate: (...args: unknown[]) => aggregate(...(args as [])),
      count: (...args: unknown[]) => count(...(args as [])),
      findMany: vi.fn(async () => hooks),
    },
    graphNodeType: {
      aggregate: (...args: unknown[]) => aggregate(...(args as [])),
      count: (...args: unknown[]) => count(...(args as [])),
      findUnique: vi.fn(async () => null),
    },
    graphNodeTypeInput: { aggregate: (...args: unknown[]) => aggregate(...(args as [])) },
    graphNodeTypeFacet: { aggregate: (...args: unknown[]) => aggregate(...(args as [])) },
    graphNodeTypeField: { aggregate: (...args: unknown[]) => aggregate(...(args as [])) },
  },
}));

const introspect = await import("./introspect.js");
const scope = { workspaceId: "ws-1", siteId: "site-1" };

describe("graphVersion", () => {
  it("returns the max updatedAt across definition tables", async () => {
    const version = await introspect.graphVersion(scope);
    expect(version.asOf).toBe("2026-07-08T12:00:00.000Z");
    expect(version.counts).toEqual({ nodes: 1, properties: 1, edges: 1, hooks: 1, types: 1 });
  });
});

describe("snapshot", () => {
  it("returns nodes, properties, edges, hooks with a version stamp", async () => {
    const result = await introspect.snapshot(scope);
    expect("data" in result).toBe(true);
    if (!("data" in result)) return;
    expect(result.data.graphVersion.asOf).toBeTruthy();
    expect(result.data.properties.map((p) => p.id)).toEqual([P_TAG, P_EXPR, P_WINDOW]);
    expect(result.data.edges).toEqual(edges);
    expect(result.data.hooks).toHaveLength(1);
  });
});

describe("explain", () => {
  it("walks transitive dependencies in both directions", async () => {
    const result = await introspect.explain(P_EXPR, scope);
    expect("data" in result, JSON.stringify(result)).toBe(true);
    if (!("data" in result)) return;
    expect(result.data.upstream).toEqual([
      expect.objectContaining({ propertyId: P_TAG, depth: 1, nodeName: NODE.name }),
    ]);
    expect(result.data.downstream).toEqual([expect.objectContaining({ propertyId: P_WINDOW, depth: 1 })]);
  });

  it("reports transitive depth beyond direct edges", async () => {
    const result = await introspect.explain(P_WINDOW, scope);
    if (!("data" in result)) throw new Error("expected data");
    expect(result.data.upstream).toEqual([
      expect.objectContaining({ propertyId: P_EXPR, depth: 1 }),
      expect.objectContaining({ propertyId: P_TAG, depth: 2 }),
    ]);
    expect(result.data.downstream).toEqual([]);
  });

  it("finds hooks watching the property via condition and context", async () => {
    const conditionSide = await introspect.explain(P_TAG, scope);
    if (!("data" in conditionSide)) throw new Error("expected data");
    expect(conditionSide.data.watchingHooks).toEqual([expect.objectContaining({ id: "hook-1", role: "condition" })]);

    const contextSide = await introspect.explain(P_WINDOW, scope);
    if (!("data" in contextSide)) throw new Error("expected data");
    expect(contextSide.data.watchingHooks).toEqual([expect.objectContaining({ id: "hook-1", role: "context" })]);
  });
});

describe("conformance", () => {
  it("reports missing fields and orphaned properties against the integration type", async () => {
    const result = await introspect.conformance(scope);
    if (!("data" in result)) throw new Error("expected data");
    expect(result.data.unknownTypeRefs).toEqual([]);
    expect(result.data.drift).toHaveLength(1);
    const drift = result.data.drift[0];
    // "@imm/station" resolves from the code catalog; it has many fields the
    // mocked node lacks, and the node's "legacyField" binding is orphaned.
    expect(drift?.nodeId).toBe(NODE.id);
    expect(drift?.missingFields.length).toBeGreaterThan(0);
    expect(drift?.missingFields).not.toContain("totalCycles");
    expect(drift?.orphanedProperties).toEqual([expect.objectContaining({ typeFieldKey: "legacyField" })]);
  });
});

describe("verifiedSiteProperties", () => {
  it("returns empty for an empty request", async () => {
    expect(await introspect.verifiedSiteProperties([], scope)).toEqual([]);
  });
});

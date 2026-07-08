import { describe, expect, it, vi } from "vitest";

const EXISTING_NODE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXISTING_PROP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEW_TAG = "11111111-1111-4111-8111-111111111111";
const NEW_EXPR = "22222222-2222-4222-8222-222222222222";
const NEW_WINDOW = "33333333-3333-4333-8333-333333333333";

const symbol = (id: string) => `p_${id.replaceAll("-", "_")}`;

vi.mock("@rw/db", () => ({
  default: {
    site: { findUnique: vi.fn(async () => ({ id: "site-1", workspaceId: "ws-1" })) },
    graphNode: {
      findFirst: vi.fn(async ({ where }: { where: { name: string } }) =>
        where.name === "Existing Node" ? { id: EXISTING_NODE } : null,
      ),
      findMany: vi.fn(async () => [{ id: EXISTING_NODE }]),
      aggregate: vi.fn(async () => ({ _max: { updatedAt: new Date("2026-07-08T12:00:00Z") } })),
      count: vi.fn(async () => 1),
    },
    graphProperty: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) => {
        const requested = where.id?.in ?? [];
        return requested.includes(EXISTING_PROP) ? [{ id: EXISTING_PROP, resolverType: "tag" }] : [];
      }),
      findUnique: vi.fn(async ({ where }: { where: { nodeId_name?: { name: string } } }) =>
        where.nodeId_name?.name === "takenName" ? { isDeleted: false } : null,
      ),
      aggregate: vi.fn(async () => ({ _max: { updatedAt: new Date("2026-07-08T12:00:00Z") } })),
      count: vi.fn(async () => 1),
    },
    graphEdge: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    graphHook: {
      findFirst: vi.fn(async () => null),
      aggregate: vi.fn(async () => ({ _max: { updatedAt: null } })),
      count: vi.fn(async () => 0),
    },
    graphNodeType: {
      findUnique: vi.fn(async () => null),
      aggregate: vi.fn(async () => ({ _max: { updatedAt: null } })),
      count: vi.fn(async () => 0),
    },
    graphNodeTypeInput: { aggregate: vi.fn(async () => ({ _max: { updatedAt: null } })) },
    graphNodeTypeFacet: { aggregate: vi.fn(async () => ({ _max: { updatedAt: null } })) },
    graphNodeTypeField: { aggregate: vi.fn(async () => ({ _max: { updatedAt: null } })) },
  },
}));

const { plan } = await import("./plan.js");
const scope = { workspaceId: "ws-1", siteId: "site-1" };

describe("plan", () => {
  it("rejects an empty plan", async () => {
    const result = await plan({}, scope);
    expect(result).toMatchObject({ code: "EMPTY_PLAN" });
  });

  it("validates a coherent batch: node + tag + expr + window + hook", async () => {
    const result = await plan(
      {
        nodes: [{ ref: "press", name: "Press 9" }],
        properties: [
          {
            id: NEW_TAG,
            nodeRef: "press",
            name: "cycleTime",
            resolverType: "tag",
            resolver: { type: "tag", deviceId: "dev-1", tagPath: "press/cycle" },
          },
          {
            id: NEW_EXPR,
            nodeRef: "press",
            name: "cycleDelta",
            resolverType: "expr",
            resolver: { type: "expr", expression: `${symbol(NEW_TAG)} - ${symbol(EXISTING_PROP)}` },
          },
          {
            id: NEW_WINDOW,
            nodeRef: "press",
            name: "cycleAvg",
            resolverType: "window",
            resolver: { type: "window", sourcePropertyId: NEW_EXPR, kind: "ewma", alpha: 0.4 },
          },
        ],
        hooks: [
          {
            name: "cycle spike",
            condition: { source: { type: "property", propertyId: NEW_WINDOW }, operator: "crossesAbove", threshold: 90 },
            eventNamespace: "imm",
            eventName: "cycle_completed",
            eventVersion: "1",
          },
        ],
      },
      scope,
    );

    expect("data" in result, JSON.stringify(result)).toBe(true);
    if (!("data" in result)) return;
    expect(result.data.issues).toEqual([]);
    expect(result.data.valid).toBe(true);
    expect(result.data.plannedEdges).toEqual(
      expect.arrayContaining([
        { fromPropertyId: NEW_TAG, toPropertyId: NEW_EXPR },
        { fromPropertyId: EXISTING_PROP, toPropertyId: NEW_EXPR },
        { fromPropertyId: NEW_EXPR, toPropertyId: NEW_WINDOW },
      ]),
    );
    expect(result.data.graphVersion.asOf).toBeTruthy();
    expect(result.data.properties).toHaveLength(3);
  });

  it("accumulates issues instead of stopping at the first", async () => {
    const result = await plan(
      {
        nodes: [{ ref: "n1", name: "Existing Node" }],
        properties: [
          { nodeRef: "ghost", name: "p1", resolverType: "tag", resolver: { type: "tag" } },
          { nodeId: EXISTING_NODE, name: "takenName", resolverType: "expr", resolver: { type: "expr", expression: "p_zzz" } },
        ],
      },
      scope,
    );
    if (!("data" in result)) throw new Error("expected data");
    expect(result.data.valid).toBe(false);
    const codes = result.data.issues.map((i) => `${i.path}:${i.code}`);
    expect(codes).toContain("nodes[0].name:GRAPH_NODE_NAME_EXISTS");
    expect(codes).toContain("properties[0].nodeRef:UNKNOWN_NODE_REF");
    expect(codes).toContain("properties[0].resolver:INVALID_RESOLVER");
    expect(codes).toContain("properties[1].name:GRAPH_PROPERTY_NAME_EXISTS");
    expect(codes).toContain("properties[1].resolver:INVALID_RESOLVER");
  });

  it("rejects a window sourcing a planned window", async () => {
    const result = await plan(
      {
        nodes: [{ ref: "n", name: "Node" }],
        properties: [
          {
            id: NEW_WINDOW,
            nodeRef: "n",
            name: "w1",
            resolverType: "window",
            resolver: { type: "window", sourcePropertyId: EXISTING_PROP, kind: "ewma", alpha: 0.5 },
          },
          {
            id: NEW_EXPR,
            nodeRef: "n",
            name: "w2",
            resolverType: "window",
            resolver: { type: "window", sourcePropertyId: NEW_WINDOW, kind: "ewma", alpha: 0.5 },
          },
        ],
      },
      scope,
    );
    if (!("data" in result)) throw new Error("expected data");
    expect(result.data.issues).toEqual([
      expect.objectContaining({ path: "properties[1].resolver", error: "window source cannot be another window property" }),
    ]);
  });

  it("detects cycles across planned expressions", async () => {
    const result = await plan(
      {
        nodes: [{ ref: "n", name: "Node" }],
        properties: [
          {
            id: NEW_TAG,
            nodeRef: "n",
            name: "a",
            resolverType: "expr",
            resolver: { type: "expr", expression: `${symbol(NEW_EXPR)} + 1` },
          },
          {
            id: NEW_EXPR,
            nodeRef: "n",
            name: "b",
            resolverType: "expr",
            resolver: { type: "expr", expression: `${symbol(NEW_TAG)} + 1` },
          },
        ],
      },
      scope,
    );
    if (!("data" in result)) throw new Error("expected data");
    expect(result.data.issues).toEqual([expect.objectContaining({ code: "GRAPH_CYCLE" })]);
  });

  it("flags hook references to properties that exist nowhere", async () => {
    const result = await plan(
      {
        hooks: [
          {
            name: "orphan hook",
            condition: {
              source: { type: "property", propertyId: "99999999-9999-4999-8999-999999999999" },
              operator: "changed",
            },
            eventNamespace: "imm",
            eventName: "cycle_completed",
          },
        ],
      },
      scope,
    );
    if (!("data" in result)) throw new Error("expected data");
    expect(result.data.issues).toEqual([expect.objectContaining({ code: "HOOK_PROPERTY_NOT_FOUND" })]);
  });

  it("assigns ids to planned properties that lack one", async () => {
    const result = await plan(
      {
        nodes: [{ ref: "n", name: "Node" }],
        properties: [
          { nodeRef: "n", name: "t", resolverType: "tag", resolver: { type: "tag", deviceId: "d", tagPath: "t" } },
        ],
      },
      scope,
    );
    if (!("data" in result)) throw new Error("expected data");
    expect(result.data.valid).toBe(true);
    expect(result.data.properties[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

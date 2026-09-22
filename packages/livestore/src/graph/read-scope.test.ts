import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@rw/db";
import {
  GRAPH_READ_CACHE_TTL_MS,
  PublishedGraphAccess,
  publishedProperty,
  type PublishedReadScope,
} from "./read-scope.js";

const scope: PublishedReadScope = {
  siteId: "s",
  workspaceId: "w",
  workcenterIds: ["wc-a"],
  referenceRead: true,
  planningRead: false,
  configurationRead: false,
  plantAdmin: false,
};
const OWN = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";
const expr = (id: string) => `p_${id.replaceAll("-", "_")}`;
const properties = new Map([
  [OWN, { resolverType: "metric", resolver: { entityType: "Station", entityId: "own" } }],
  [FOREIGN, { resolverType: "metric", resolver: { entityType: "Station", entityId: "foreign" } }],
]);
const db = {
  station: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
      siteId: "s",
      workcenterId: where.id === "own" ? "wc-a" : "wc-b",
    })),
  },
  job: { findUnique: vi.fn(async () => ({ siteId: "s" })) },
  product: { findUnique: vi.fn(async () => ({ siteId: "s" })) },
  graphProperty: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const p = properties.get(where.id);
      return p ? { ...p, isDeleted: false, updatedAt: new Date(100), node: { siteId: "s", isDeleted: false } } : null;
    }),
  },
} as unknown as PrismaClient;

beforeEach(() => vi.clearAllMocks());

describe("published graph data scope", () => {
  it("proves every expression/window/totalizer dependency, not just the owning node", async () => {
    const access = new PublishedGraphAccess(scope, db);
    expect(await access.resolver("expr", { expression: `${expr(OWN)} * 2` })).toBe(true);
    expect(await access.resolver("expr", { expression: `${expr(OWN)} + ${expr(FOREIGN)}` })).toBe(false);
    expect(await access.resolver("window", { sourcePropertyId: FOREIGN })).toBe(false);
    expect(
      await access.resolver("totalizer", { sourcePropertyId: OWN, trigger: { source: { propertyId: FOREIGN } } }),
    ).toBe(false);
    expect(await access.property("unknown")).toBe(false);
  });
  it("does not classify plant summaries, job pointers or dynamic rollups as shared", async () => {
    const access = new PublishedGraphAccess(scope, db);
    expect(await access.entity("imm.site", "s", "name")).toBe(true);
    expect(await access.entity("imm.site", "s", "stations")).toBe(false);
    expect(await access.entity("imm.job", "job", "stations")).toBe(false);
    expect(await access.entity("imm.product", "product", "currentVersion.name")).toBe(true);
    expect(await access.entity("imm.product", "product", "workOrders")).toBe(false);
    expect(await access.resolver("rollup", { parent: { model: "Site", id: "s" } })).toBe(false);
    expect(await access.resolver("metric", { entityType: "Site", entityId: "s" })).toBe(false);
  });
  it("filters node properties and strips unproven metadata", async () => {
    const access = new PublishedGraphAccess(scope, db);
    const node = await access.node({
      id: "n",
      siteId: "s",
      facets: { workcenterId: "wc-b" },
      typeContext: { stationId: "foreign" },
      properties: [{ id: OWN }, { id: FOREIGN }],
      requestedProperties: { own: { id: OWN }, secret: { id: FOREIGN } },
    });
    expect(node).toMatchObject({
      properties: [{ id: OWN }],
      facets: {},
      typeContext: {},
      requestedProperties: { secret: null },
    });
    expect(await access.node({ id: "n", siteId: "s", properties: [{ id: FOREIGN }] })).toBeNull();
  });
  it("does not publish cached values from before a resolver ownership edit", async () => {
    const access = new PublishedGraphAccess(scope, db);
    expect(await access.property(OWN, new Set(), 50)).toBe(false);
    expect(await access.property(OWN, new Set(), 100)).toBe(true);
  });
  it("does not leak sibling properties or native pointers through property.get's parent include", () => {
    expect(
      publishedProperty({
        id: OWN,
        node: {
          id: "n",
          siteId: "s",
          properties: [{ id: FOREIGN }],
          facets: { stationId: "foreign" },
          typeContext: { stationId: "foreign" },
        },
      }),
    ).toEqual({ id: OWN, node: { id: "n", siteId: "s" } });
  });
  it("retains full-site production aggregates without granting employee or planning data", async () => {
    const access = new PublishedGraphAccess({ ...scope, workcenterIds: undefined }, db);
    expect(await access.resolver("metric", { entityType: "Site", entityId: "s" })).toBe(true);
    expect(await access.entity("imm.site", "s", "stations")).toBe(true);
    expect(await access.resolver("rollup", {})).toBe(true);
    expect(await access.entity("imm.employee", "employee", "version.firstName")).toBe(false);
    for (const path of [
      "currentVersion.quantityUnit",
      "currentVersion.standardRateUnit",
      "currentVersion.downtimeDetect",
    ]) {
      expect(await access.entity("imm.station", "own", path)).toBe(true);
    }
  });
});

describe("configuration definitions versus published values", () => {
  const context = { station: "own", layout: { columns: 3, label: "Editor layout" }, customSetting: ["a", "b"] };
  const configurationDb = {
    ...db,
    graphNodeType: {
      findUnique: vi.fn(async () => ({
        isDeleted: false,
        facets: [
          {
            key: "cell_name",
            resolverType: "entity",
            resolver: { entityRef: { key: "imm.station", id: "$input.station" }, path: "name" },
          },
          {
            key: "private_profile",
            resolverType: "entity",
            resolver: { entityRef: { key: "imm.employee", id: "employee" }, path: "version.firstName" },
          },
        ],
      })),
    },
  } as unknown as PrismaClient;

  it("preserves full-site engineering custom definition inputs, facets and resolver config", async () => {
    const access = new PublishedGraphAccess(
      { ...scope, configurationRead: true, workcenterIds: undefined },
      configurationDb,
    );
    const property = {
      id: OWN,
      name: "status",
      resolver: { type: "metric", entityType: "Station", entityId: "own" },
      current: { value: "UP", quality: "good", timestamp: 100 },
    };
    const original = {
      id: "n",
      siteId: "s",
      typeRef: "custom_cell",
      typeContext: context,
      facets: { cell_name: "Cell A" },
      properties: [property],
      requestedProperties: { status: property },
    };
    expect(await access.node(original)).toEqual(original);
    expect(
      await access.definitionMetadata({ ...original, facets: { cell_name: "Cell A", private_profile: "PRIVATE" } }),
    ).toMatchObject({ typeContext: context, facets: { cell_name: "Cell A", private_profile: null } });
  });

  it("configuration-only readers retain editable properties but never denied current/facet values or aliases", async () => {
    const access = new PublishedGraphAccess(
      { ...scope, configurationRead: true, workcenterIds: [], referenceRead: false },
      configurationDb,
    );
    const property = {
      id: FOREIGN,
      resolver: { type: "metric", entityType: "Station", entityId: "foreign" },
      current: { value: "SECRET", quality: "good", timestamp: 100, context: { privateStatus: "SECRET" } },
    };
    const node = await access.node({
      id: "n",
      siteId: "s",
      typeRef: "custom_cell",
      typeContext: context,
      facets: { cell_name: "PRIVATE NAME" },
      properties: [property],
      requestedProperties: { status: property },
    });
    expect(node).toMatchObject({
      typeContext: context,
      facets: { cell_name: null },
      properties: [
        { id: FOREIGN, resolver: property.resolver, current: { value: null, quality: "stale", timestamp: 0 } },
      ],
      requestedProperties: { status: { id: FOREIGN, current: { value: null } } },
    });
    expect(JSON.stringify(node)).not.toContain("SECRET");
    expect(JSON.stringify(node)).not.toContain("PRIVATE NAME");
    expect(await access.property(FOREIGN)).toBe(false);
    expect(await access.node({ id: "empty", siteId: "s", typeContext: context, properties: [] })).toMatchObject({
      id: "empty",
      typeContext: context,
      properties: [],
    });
  });

  it("ordinary scoped members still lose foreign definition metadata and native runtime values", async () => {
    const access = new PublishedGraphAccess(scope, configurationDb);
    const own = { id: OWN, current: { value: 10, quality: "good", timestamp: 100 } };
    const foreign = { id: FOREIGN, current: { value: "FOREIGN VALUE", quality: "good", timestamp: 100 } };
    const node = await access.node({
      id: "n",
      siteId: "s",
      typeRef: "custom_cell",
      typeContext: { secretPointer: "foreign-wc" },
      facets: { secretPointer: "foreign-wc" },
      properties: [own, foreign],
      requestedProperties: { own, foreign },
    });
    expect(node).toMatchObject({
      typeContext: {},
      facets: {},
      properties: [own],
      requestedProperties: { own, foreign: null },
    });
    expect(JSON.stringify(node)).not.toContain("foreign-wc");
    expect(JSON.stringify(node)).not.toContain("FOREIGN VALUE");
    expect(await access.node({ id: "elsewhere", siteId: "other-site", properties: [own] })).toBeNull();
  });
});

describe("per-connection graph proof memoization", () => {
  it("deduplicates concurrent lookups and reuses proofs across changing value timestamps", async () => {
    const access = new PublishedGraphAccess(scope, db);
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) => access.property(OWN, new Set(), 100 + index)),
    );
    expect(results.every(Boolean)).toBe(true);
    expect(db.graphProperty.findUnique).toHaveBeenCalledTimes(1);
    expect(db.station.findUnique).toHaveBeenCalledTimes(1);
    // Timestamp freshness is checked per delivery, not cached as a boolean by property id.
    expect(await access.property(OWN, new Set(), 99)).toBe(false);
    expect(db.graphProperty.findUnique).toHaveBeenCalledTimes(1);
  });

  it("invalidates ownership decisions at the bounded TTL and on explicit change signals", async () => {
    let now = 1000;
    let workcenterId = "wc-a";
    const station = vi.fn(async () => ({ siteId: "s", workcenterId }));
    const connectionDb = { ...db, station: { findUnique: station } } as unknown as PrismaClient;
    const access = new PublishedGraphAccess(scope, connectionDb, () => now);
    expect(await access.property(OWN)).toBe(true);
    workcenterId = "wc-b";
    expect(await access.property(OWN)).toBe(true);
    now += GRAPH_READ_CACHE_TTL_MS;
    expect(await access.property(OWN)).toBe(false);
    workcenterId = "wc-a";
    access.invalidate();
    expect(await access.property(OWN)).toBe(true);
    expect(station).toHaveBeenCalledTimes(3);
  });

  it("does not share caches between different user grants", async () => {
    expect(await new PublishedGraphAccess(scope, db).property(OWN)).toBe(true);
    expect(await new PublishedGraphAccess({ ...scope, workcenterIds: ["wc-b"] }, db).property(OWN)).toBe(false);
    expect(db.station.findUnique).toHaveBeenCalledTimes(2);
  });

  it("an in-flight proof cannot survive invalidation", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connectionDb = {
      ...db,
      station: {
        findUnique: async () => {
          await gate;
          return { siteId: "s", workcenterId: "wc-a" };
        },
      },
    } as unknown as PrismaClient;
    const access = new PublishedGraphAccess(scope, connectionDb);
    const pending = access.property(OWN);
    access.invalidate();
    release();
    expect(await pending).toBe(false);
    expect(await access.property(OWN)).toBe(true);
  });

  it("cyclic dependencies fail closed even with simultaneous roots", async () => {
    const cyclicDb = {
      ...db,
      graphProperty: {
        findUnique: async ({ where }: { where: { id: string } }) => ({
          isDeleted: false,
          updatedAt: new Date(100),
          node: { siteId: "s", isDeleted: false },
          resolverType: "expr",
          resolver: { expression: expr(where.id === OWN ? FOREIGN : OWN) },
        }),
      },
    } as unknown as PrismaClient;
    const access = new PublishedGraphAccess(scope, cyclicDb);
    expect(await Promise.all([access.property(OWN), access.property(FOREIGN)])).toEqual([false, false]);
  });
});

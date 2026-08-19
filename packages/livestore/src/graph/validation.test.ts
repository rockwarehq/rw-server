import { describe, expect, it, vi } from "vitest";

vi.mock("@rw/db", () => ({
  default: {
    station: { findFirst: vi.fn(async () => ({ id: "station-1" })) },
    point: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "point-1" ? { id: "point-1" } : null,
      ),
    },
  },
}));

const { validateResolverConfig } = await import("./validation.js");
import type { GraphScope } from "./types.js";

const scope: GraphScope = { workspaceId: "ws-1", siteId: "site-1" };

describe("validateResolverConfig expr", () => {
  it("rejects property-shaped symbols that are not UUID property references", async () => {
    const result = await validateResolverConfig({
      resolverType: "expr",
      resolver: { type: "expr", expression: "p_missing + 1" },
      scope,
    });
    expect(result).toMatchObject({ code: "INVALID_RESOLVER" });
    expect((result as { error: string }).error).toContain("p_missing");
  });

  it("accepts UUID-shaped property symbols", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const symbol = `p_${id.replaceAll("-", "_")}`;
    const result = await validateResolverConfig({
      resolverType: "expr",
      resolver: { type: "expr", expression: `${symbol} * 2` },
      scope,
      knownPropertyIds: new Set([id]), // in-batch sibling: skips the site check
    });
    expect(result).toMatchObject({ data: { dependencyIds: [id] } });
  });

  it("rejects a disallowed function at save time (sandbox whitelist)", async () => {
    const result = await validateResolverConfig({
      resolverType: "expr",
      resolver: { type: "expr", expression: "sin(1)" },
      scope,
    });
    expect(result).toMatchObject({ code: "INVALID_RESOLVER" });
    expect((result as { error: string }).error).toContain("validation failed");
  });

  it("rejects an over-length expression at save time", async () => {
    const result = await validateResolverConfig({
      resolverType: "expr",
      resolver: { type: "expr", expression: `1 + ${"1 + ".repeat(600)}1` },
      scope,
    });
    expect(result).toMatchObject({ code: "INVALID_RESOLVER" });
  });
});

describe("validateResolverConfig entity path", () => {
  it("rejects a path that is not in the entity catalog", async () => {
    const result = await validateResolverConfig({
      resolverType: "entity",
      resolver: { type: "entity", entityType: "imm.station", entityId: "station-1", path: "garbagepath" },
      scope,
    });
    expect(result).toMatchObject({ code: "ENTITY_PATH_NOT_FOUND" });
  });

  it("accepts a catalogued path and the runtime-special id path", async () => {
    for (const path of ["standardCycle", "id", "status", "statusReasonId", "statusReason", "statusStartAt"]) {
      const result = await validateResolverConfig({
        resolverType: "entity",
        resolver: { type: "entity", entityType: "imm.station", entityId: "station-1", path },
        scope,
      });
      expect("data" in result, `path ${path} should validate`).toBe(true);
    }
  });
});

describe("validateResolverConfig datasource.point", () => {
  it("accepts a static point in the site", async () => {
    const result = await validateResolverConfig({
      resolverType: "entity",
      resolver: { type: "entity", entityType: "datasource.point", entityId: "point-1", path: "staticValue" },
      scope,
    });
    expect("data" in result).toBe(true);
  });

  it("rejects a point outside the site", async () => {
    const result = await validateResolverConfig({
      resolverType: "entity",
      resolver: { type: "entity", entityType: "datasource.point", entityId: "point-elsewhere", path: "staticValue" },
      scope,
    });
    expect(result).toMatchObject({ code: "ENTITY_SITE_MISMATCH" });
  });

  it("rejects a path that is not in the point catalog", async () => {
    const result = await validateResolverConfig({
      resolverType: "entity",
      resolver: { type: "entity", entityType: "datasource.point", entityId: "point-1", path: "address" },
      scope,
    });
    expect(result).toMatchObject({ code: "ENTITY_PATH_NOT_FOUND" });
  });

  it("rejects points as metric targets", async () => {
    const result = await validateResolverConfig({
      resolverType: "metric",
      resolver: {
        type: "metric",
        entityType: "Point",
        entityId: "point-1",
        granularity: "SHIFT",
        metricKey: "goodCount",
      },
      scope,
    });
    expect(result).toMatchObject({ code: "INVALID_RESOLVER" });
  });
});

describe("validateResolverConfig totalizer", () => {
  const SRC = "11111111-1111-4111-8111-111111111111";
  const TRIG = "22222222-2222-4222-8222-222222222222";

  it("returns both source and trigger as dependencies", async () => {
    const result = await validateResolverConfig({
      resolverType: "totalizer",
      resolver: {
        type: "totalizer",
        sourcePropertyId: SRC,
        trigger: { source: { type: "property", propertyId: TRIG }, operator: "crossesAbove", threshold: 0.5 },
      },
      scope,
      knownPropertyIds: new Set([SRC, TRIG]),
    });
    expect(result).toMatchObject({ data: { dependencyIds: [SRC, TRIG] } });
  });

  it("dedupes the dependency when the trigger is the source", async () => {
    const result = await validateResolverConfig({
      resolverType: "totalizer",
      resolver: {
        type: "totalizer",
        sourcePropertyId: SRC,
        trigger: { source: { type: "property", propertyId: SRC }, operator: "changed" },
      },
      scope,
      knownPropertyIds: new Set([SRC]),
    });
    expect(result).toMatchObject({ data: { dependencyIds: [SRC] } });
  });

  it("rejects a trigger missing its operator-required config", async () => {
    const result = await validateResolverConfig({
      resolverType: "totalizer",
      resolver: {
        type: "totalizer",
        sourcePropertyId: SRC,
        trigger: { source: { type: "property", propertyId: TRIG }, operator: "gt" }, // no threshold
      },
      scope,
      knownPropertyIds: new Set([SRC, TRIG]),
    });
    expect(result).toMatchObject({ code: "INVALID_RESOLVER" });
    expect((result as { error: string }).error).toContain("trigger");
  });

  it("includes the reset property as a dependency, deduped against source and trigger", async () => {
    const RESET = "33333333-3333-4333-8333-333333333333";
    const result = await validateResolverConfig({
      resolverType: "totalizer",
      resolver: {
        type: "totalizer",
        sourcePropertyId: SRC,
        trigger: { source: { type: "property", propertyId: TRIG }, operator: "increases" },
        reset: { source: { type: "property", propertyId: RESET }, operator: "changed" },
      },
      scope,
      knownPropertyIds: new Set([SRC, TRIG, RESET]),
    });
    expect(result).toMatchObject({ data: { dependencyIds: [SRC, TRIG, RESET] } });

    const deduped = await validateResolverConfig({
      resolverType: "totalizer",
      resolver: {
        type: "totalizer",
        sourcePropertyId: SRC,
        trigger: { source: { type: "property", propertyId: TRIG }, operator: "increases" },
        reset: { source: { type: "property", propertyId: TRIG }, operator: "changed" },
      },
      scope,
      knownPropertyIds: new Set([SRC, TRIG]),
    });
    expect(deduped).toMatchObject({ data: { dependencyIds: [SRC, TRIG] } });
  });

  it("rejects a reset missing its operator-required config", async () => {
    const result = await validateResolverConfig({
      resolverType: "totalizer",
      resolver: {
        type: "totalizer",
        sourcePropertyId: SRC,
        trigger: { source: { type: "property", propertyId: SRC }, operator: "changed" },
        reset: { source: { type: "property", propertyId: TRIG }, operator: "equals" }, // no value
      },
      scope,
      knownPropertyIds: new Set([SRC, TRIG]),
    });
    expect(result).toMatchObject({ code: "INVALID_RESOLVER" });
    expect((result as { error: string }).error).toContain("reset");
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("@rw/db", () => ({
  default: {
    station: { findFirst: vi.fn(async () => ({ id: "station-1" })) },
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

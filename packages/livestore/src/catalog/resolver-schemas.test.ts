import { describe, expect, it, vi } from "vitest";

// Mirrors graph/validation.test.ts's mock so validateResolverConfig's
// referential checks pass and only structural behavior is compared.
vi.mock("@rw/db", () => ({
  default: {
    station: { findFirst: vi.fn(async () => ({ id: "s1" })) },
    workcenter: { findFirst: vi.fn(async () => ({ id: "wc-1" })) },
    graphProperty: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id: string) => ({ id, resolverType: "tag" })),
      ),
    },
  },
}));

import { buildLivestoreCapabilityManifest } from "./manifest.js";
import {
  LIVESTORE_RESOLVER_CONFIG_SCHEMAS,
  LIVESTORE_RESOLVER_TYPES,
  livestoreResolverConfigSchema,
} from "./resolver-schemas.js";

interface Fixture {
  name: string;
  resolver: Record<string, unknown>;
  ok: boolean;
  // Expected first-issue message on rejection — must match the historical
  // validateResolverConfig error strings verbatim (graph/validation.ts).
  message?: string;
}

const PROP_ID = "11111111-1111-4111-8111-111111111111";

const FIXTURES: Record<(typeof LIVESTORE_RESOLVER_TYPES)[number], Fixture[]> = {
  tag: [
    { name: "valid", resolver: { type: "tag", deviceId: "dev-1", tagPath: "a/b" }, ok: true },
    { name: "extra keys pass through", resolver: { type: "tag", deviceId: "d", tagPath: "t", note: "x" }, ok: true },
    {
      name: "missing tagPath",
      resolver: { type: "tag", deviceId: "dev-1" },
      ok: false,
      message: "tag resolver requires deviceId and tagPath",
    },
    {
      name: "non-string deviceId",
      resolver: { type: "tag", deviceId: 5, tagPath: "a" },
      ok: false,
      message: "tag resolver requires deviceId and tagPath",
    },
  ],
  metric: [
    {
      name: "valid",
      resolver: {
        type: "metric",
        entityType: "Station",
        entityId: "s1",
        granularity: "SHIFT",
        metricKey: "totalCycles",
      },
      ok: true,
    },
    {
      name: "missing metricKey",
      resolver: { type: "metric", entityType: "Station", entityId: "s1", granularity: "SHIFT" },
      ok: false,
      message: "metric resolver requires entityType, entityId, granularity, and metricKey",
    },
  ],
  entity: [
    { name: "valid", resolver: { type: "entity", entityType: "imm.station", entityId: "s1", path: "name" }, ok: true },
    {
      name: "missing path",
      resolver: { type: "entity", entityType: "imm.station", entityId: "s1" },
      ok: false,
      message: "entity resolver requires entityType, entityId, and path",
    },
  ],
  expr: [
    { name: "valid", resolver: { type: "expr", expression: `p_${PROP_ID.replaceAll("-", "_")} * 2` }, ok: true },
    {
      name: "missing expression",
      resolver: { type: "expr" },
      ok: false,
      message: "expr resolver requires expression",
    },
    {
      name: "blank expression",
      resolver: { type: "expr", expression: "   " },
      ok: false,
      message: "expr resolver requires expression",
    },
  ],
  window: [
    {
      name: "valid tumbling",
      resolver: { type: "window", sourcePropertyId: PROP_ID, kind: "tumbling", windowMs: 60000, aggregation: "avg" },
      ok: true,
    },
    { name: "valid ewma", resolver: { type: "window", sourcePropertyId: PROP_ID, kind: "ewma", alpha: 0.3 }, ok: true },
    {
      name: "bad kind",
      resolver: { type: "window", sourcePropertyId: PROP_ID, kind: "sliding" },
      ok: false,
      message: "window kind must be tumbling or ewma",
    },
    {
      name: "tumbling windowMs too small",
      resolver: { type: "window", sourcePropertyId: PROP_ID, kind: "tumbling", windowMs: 500, aggregation: "avg" },
      ok: false,
      message: "tumbling windowMs must be a finite number >= 1000",
    },
    {
      name: "tumbling missing aggregation",
      resolver: { type: "window", sourcePropertyId: PROP_ID, kind: "tumbling", windowMs: 60000 },
      ok: false,
      message: "tumbling aggregation must be one of sum, avg, count, min, max",
    },
    {
      name: "tumbling bad aggregation",
      resolver: { type: "window", sourcePropertyId: PROP_ID, kind: "tumbling", windowMs: 60000, aggregation: "median" },
      ok: false,
      message: "tumbling aggregation must be one of sum, avg, count, min, max",
    },
    {
      name: "ewma alpha zero",
      resolver: { type: "window", sourcePropertyId: PROP_ID, kind: "ewma", alpha: 0 },
      ok: false,
      message: "ewma alpha must be a number in (0, 1]",
    },
    {
      name: "ewma alpha above one",
      resolver: { type: "window", sourcePropertyId: PROP_ID, kind: "ewma", alpha: 1.5 },
      ok: false,
      message: "ewma alpha must be a number in (0, 1]",
    },
  ],
  rollup: [
    {
      name: "valid",
      resolver: {
        type: "rollup",
        childKind: "station",
        relation: "stations",
        childProperty: "oee",
        aggregation: "avg",
      },
      ok: true,
    },
    {
      name: "valid with parent and weightBy",
      resolver: {
        type: "rollup",
        childKind: "station",
        relation: "stations",
        childProperty: "oee",
        aggregation: "avg",
        parent: { model: "Workcenter", id: "wc-1" },
        weightBy: "runSeconds",
      },
      ok: true,
    },
    {
      name: "bad aggregation",
      resolver: {
        type: "rollup",
        childKind: "station",
        relation: "stations",
        childProperty: "oee",
        aggregation: "p95",
      },
      ok: false,
      message: "rollup resolver requires childKind, relation, childProperty, and aggregation",
    },
    {
      name: "parent not an object",
      resolver: {
        type: "rollup",
        childKind: "station",
        relation: "stations",
        childProperty: "oee",
        aggregation: "sum",
        parent: "wc-1",
      },
      ok: false,
      message: "rollup parent must include model and id",
    },
    {
      name: "parent missing id",
      resolver: {
        type: "rollup",
        childKind: "station",
        relation: "stations",
        childProperty: "oee",
        aggregation: "sum",
        parent: { model: "Workcenter" },
      },
      ok: false,
      message: "rollup parent must include model and id",
    },
  ],
};

describe("resolver config schemas", () => {
  for (const resolverType of LIVESTORE_RESOLVER_TYPES) {
    describe(resolverType, () => {
      for (const fixture of FIXTURES[resolverType]) {
        it(fixture.name, () => {
          const schema = LIVESTORE_RESOLVER_CONFIG_SCHEMAS[resolverType];
          const result = schema.safeParse(fixture.resolver);
          expect(result.success, result.success ? undefined : result.error.issues[0]?.message).toBe(fixture.ok);
          if (!fixture.ok && fixture.message) {
            expect(result.success).toBe(false);
            if (!result.success) expect(result.error.issues[0]?.message).toBe(fixture.message);
          }
        });
      }
    });
  }

  it("passes extra keys through unchanged", () => {
    const result = LIVESTORE_RESOLVER_CONFIG_SCHEMAS.tag.safeParse({
      type: "tag",
      deviceId: "d",
      tagPath: "t",
      annotation: { by: "agent" },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ annotation: { by: "agent" } });
  });

  it("returns null for unknown resolver types", () => {
    expect(livestoreResolverConfigSchema("webhook")).toBeNull();
  });
});

describe("capability manifest", () => {
  const manifest = buildLivestoreCapabilityManifest();

  it("describes every resolver type with a JSON schema", () => {
    expect(manifest.resolverTypes.map((r) => r.type)).toEqual([...LIVESTORE_RESOLVER_TYPES]);
    for (const descriptor of manifest.resolverTypes) {
      // Object schemas carry properties; the window union carries oneOf.
      const hasShape = "properties" in descriptor.configSchema || "oneOf" in descriptor.configSchema;
      expect(hasShape, `configSchema for ${descriptor.type}`).toBe(true);
    }
  });

  it("JSON schemas are serializable and stable", () => {
    expect(() => JSON.stringify(manifest)).not.toThrow();
    expect(buildLivestoreCapabilityManifest()).toBe(manifest);
  });

  it("covers every hook condition operator exactly once", () => {
    const operators = manifest.hookConditions.operators.map((op) => op.operator);
    expect(new Set(operators).size).toBe(operators.length);
    expect(operators.sort()).toEqual(
      [
        "changed",
        "increases",
        "decreases",
        "equals",
        "notEquals",
        "gt",
        "gte",
        "lt",
        "lte",
        "crossesAbove",
        "crossesBelow",
      ].sort(),
    );
  });

  it("exposes the hook event catalog", () => {
    expect(manifest.hookEvents.length).toBeGreaterThan(0);
    for (const event of manifest.hookEvents) {
      expect(event.namespace).toBeTruthy();
      expect(event.name).toBeTruthy();
      expect(event.contextFields).toBeDefined();
    }
  });
});

describe("hook condition operator descriptors agree with the parser", async () => {
  const { parseGraphHookCondition } = await import("./hook-conditions.js");
  const manifest = buildLivestoreCapabilityManifest();
  const source = { type: "property", propertyId: PROP_ID };

  for (const descriptor of manifest.hookConditions.operators) {
    it(descriptor.operator, () => {
      const bare = parseGraphHookCondition({ source, operator: descriptor.operator });
      if (descriptor.requiresThreshold || descriptor.requiresValue) {
        expect(bare, "bare condition should be rejected").toBeNull();
      } else {
        expect(bare, "bare condition should parse").not.toBeNull();
      }
      const withArgs = parseGraphHookCondition({
        source,
        operator: descriptor.operator,
        ...(descriptor.requiresValue ? { value: 1 } : {}),
        ...(descriptor.requiresThreshold ? { threshold: 1 } : {}),
      });
      expect(withArgs, "condition with required args should parse").not.toBeNull();
      if (descriptor.supportsMinDelta) {
        expect(parseGraphHookCondition({ source, operator: descriptor.operator, minDelta: 0.5 })).not.toBeNull();
      }
    });
  }
});

describe("schema/validator parity (structural layer)", async () => {
  const { validateResolverConfig } = await import("../graph/validation.js");
  const scope = { workspaceId: "ws-1", siteId: "site-1" };

  for (const resolverType of LIVESTORE_RESOLVER_TYPES) {
    for (const fixture of FIXTURES[resolverType]) {
      // Metric fixtures hit assertKnownEntityInSite with entityType values the
      // mock can't satisfy generically — structural fixtures still apply.
      it(`${resolverType}: ${fixture.name}`, async () => {
        const result = await validateResolverConfig({
          resolverType,
          resolver: fixture.resolver,
          scope,
        });
        if (fixture.ok) {
          expect("data" in result, `validator should accept: ${JSON.stringify(result)}`).toBe(true);
        } else {
          expect("error" in result).toBe(true);
          if ("error" in result && fixture.message) expect(result.error).toBe(fixture.message);
        }
      });
    }
  }
});

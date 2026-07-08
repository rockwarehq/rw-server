import { describe, expect, it } from "vitest";

import { evaluateRollup, type RollupChild } from "./rollup.js";
import type { Quality, RollupResolverConfig, ValueEnvelope } from "../types/index.js";

const env = (value: number | null, quality: Quality = "good", timestamp = 1000): ValueEnvelope => ({
  value,
  quality,
  timestamp,
});

const resolver = (overrides: Partial<RollupResolverConfig> = {}): RollupResolverConfig => ({
  type: "rollup",
  childKind: "Station",
  relation: "stations",
  childProperty: "oee",
  aggregation: "avg",
  ...overrides,
});

const child = (value: number | null, weight?: ValueEnvelope): RollupChild => ({
  current: env(value),
  weight,
});

describe("evaluateRollup weightBy", () => {
  it("computes a plain average without weightBy", () => {
    const result = evaluateRollup(resolver(), [child(90), child(20)]);
    expect(result.value).toBe(55);
    expect(result.quality).toBe("good");
  });

  it("weights each child by its sibling weight", () => {
    const result = evaluateRollup(resolver({ weightBy: "runtime" }), [child(500, env(4)), child(250, env(8))]);
    expect(result.value).toBeCloseTo(1000 / 3);
    expect(result.quality).toBe("good");
  });

  it("excludes zero-weight children and degrades quality to uncertain", () => {
    const result = evaluateRollup(resolver({ weightBy: "runtime" }), [child(90, env(8)), child(20, env(0))]);
    expect(result.value).toBe(90);
    expect(result.quality).toBe("uncertain");
  });

  it("excludes children with a missing or bad-quality weight", () => {
    const result = evaluateRollup(resolver({ weightBy: "runtime" }), [
      child(90, env(8)),
      child(20),
      child(50, env(4, "bad")),
    ]);
    expect(result.value).toBe(90);
    expect(result.quality).toBe("uncertain");
  });

  it("returns null when no child has a usable weight", () => {
    const result = evaluateRollup(resolver({ weightBy: "runtime" }), [child(90, env(0)), child(20)]);
    expect(result.value).toBeNull();
    expect(result.quality).toBe("uncertain");
  });

  it("ignores weightBy for non-avg aggregations", () => {
    const result = evaluateRollup(resolver({ aggregation: "sum", weightBy: "runtime" }), [
      child(90, env(0)),
      child(20),
    ]);
    expect(result.value).toBe(110);
    expect(result.quality).toBe("good");
  });

  it("still propagates worst child quality and partial coverage", () => {
    const result = evaluateRollup(resolver({ weightBy: "runtime" }), [
      child(90, env(8)),
      { current: env(null, "bad"), weight: env(4) },
    ]);
    expect(result.value).toBe(90);
    expect(result.quality).toBe("uncertain");
    expect(result.context).toMatchObject({ childCount: 2, present: 1 });
  });
});

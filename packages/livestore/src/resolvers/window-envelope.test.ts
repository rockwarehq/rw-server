import { describe, expect, it } from "vitest";

import { foldEwmaSample, initEwmaState, initTumblingState } from "./window-fold.js";
import { aggregateTumbling, buildEwmaEnvelope, buildTumblingEnvelope, tumblingQuality } from "./window-envelope.js";
import type { TumblingState } from "../types/index.js";

const stateWith = (overrides: Partial<TumblingState>): TumblingState => ({
  ...initTumblingState(0, 10_000),
  ...overrides,
});

describe("aggregateTumbling", () => {
  const filled = stateWith({ count: 4, sum: 20, min: 2, max: 9 });

  it("computes each aggregation", () => {
    expect(aggregateTumbling(filled, "sum")).toBe(20);
    expect(aggregateTumbling(filled, "count")).toBe(4);
    expect(aggregateTumbling(filled, "avg")).toBe(5);
    expect(aggregateTumbling(filled, "min")).toBe(2);
    expect(aggregateTumbling(filled, "max")).toBe(9);
  });

  it("empty bucket: avg/min/max are null, sum/count are 0", () => {
    const empty = initTumblingState(0, 10_000);
    expect(aggregateTumbling(empty, "avg")).toBeNull();
    expect(aggregateTumbling(empty, "min")).toBeNull();
    expect(aggregateTumbling(empty, "max")).toBeNull();
    expect(aggregateTumbling(empty, "sum")).toBe(0);
    expect(aggregateTumbling(empty, "count")).toBe(0);
  });
});

describe("tumblingQuality", () => {
  it("no usable samples is bad", () => {
    expect(tumblingQuality(stateWith({ count: 0, totalCount: 5 }))).toBe("bad");
  });

  it("minority strictly-good is uncertain", () => {
    expect(tumblingQuality(stateWith({ count: 4, goodCount: 1, totalCount: 4 }))).toBe("uncertain");
  });

  it("exactly half good is good (threshold is strict-less-than)", () => {
    expect(tumblingQuality(stateWith({ count: 4, goodCount: 2, totalCount: 4 }))).toBe("good");
  });
});

describe("buildTumblingEnvelope", () => {
  it("carries the window span and count in context", () => {
    const state = stateWith({ count: 2, sum: 8, goodCount: 2, totalCount: 2 });
    const envelope = buildTumblingEnvelope(state, "avg", 10_000);
    expect(envelope).toEqual({
      value: 4,
      quality: "good",
      timestamp: 10_000,
      context: { count: 2, windowStart: 0, windowEnd: 10_000 },
    });
  });
});

describe("buildEwmaEnvelope", () => {
  it("passes input quality and timestamp through", () => {
    const state = foldEwmaSample(initEwmaState(), { value: 7, quality: "stale", timestamp: 4_000 }, 0.4);
    expect(buildEwmaEnvelope(state)).toEqual({ value: 7, quality: "stale", timestamp: 4_000 });
  });
});

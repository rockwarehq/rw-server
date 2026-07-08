import { describe, expect, it } from "vitest";

import { bucketStartFor, foldEwmaSample, foldTumblingSample, initEwmaState, initTumblingState } from "./window-fold.js";
import type { Quality, ValueEnvelope } from "../types/index.js";

const sample = (value: unknown, quality: Quality = "good", timestamp = 1000): ValueEnvelope => ({
  value,
  quality,
  timestamp,
});

describe("bucketStartFor", () => {
  it("floors to the epoch grid by default", () => {
    expect(bucketStartFor(10_500, 10_000)).toBe(10_000);
    expect(bucketStartFor(9_999, 10_000)).toBe(0);
  });

  it("an exact boundary timestamp opens the new bucket", () => {
    expect(bucketStartFor(20_000, 10_000)).toBe(20_000);
  });

  it("aligns to a nonzero anchor", () => {
    expect(bucketStartFor(10_500, 10_000, 3_000)).toBe(3_000);
    expect(bucketStartFor(13_500, 10_000, 3_000)).toBe(13_000);
  });

  it("handles timestamps before the anchor (negative grid steps)", () => {
    expect(bucketStartFor(1_000, 10_000, 5_000)).toBe(-5_000);
  });
});

describe("foldTumblingSample", () => {
  it("accumulates count/sum/min/max for usable samples", () => {
    let state = initTumblingState(0, 10_000);
    state = foldTumblingSample(state, sample(4));
    state = foldTumblingSample(state, sample(2, "stale"));
    state = foldTumblingSample(state, sample(6));
    expect(state).toMatchObject({ count: 3, sum: 12, min: 2, max: 6, goodCount: 2, totalCount: 3 });
  });

  it("unusable samples bump only totalCount", () => {
    let state = initTumblingState(0, 10_000);
    state = foldTumblingSample(state, sample(99, "bad"));
    state = foldTumblingSample(state, sample("not a number"));
    state = foldTumblingSample(state, sample(null));
    state = foldTumblingSample(state, sample(Number.POSITIVE_INFINITY));
    expect(state).toMatchObject({ count: 0, sum: 0, min: null, max: null, goodCount: 0, totalCount: 4 });
  });

  it("does not mutate the input state", () => {
    const state = initTumblingState(0, 10_000);
    foldTumblingSample(state, sample(4));
    expect(state.count).toBe(0);
  });
});

describe("foldEwmaSample", () => {
  it("seeds from the first usable sample instead of decaying from 0", () => {
    const state = foldEwmaSample(initEwmaState(), sample(10, "good", 5_000), 0.3);
    expect(state).toMatchObject({ value: 10, lastInputTs: 5_000, lastInputQuality: "good" });
  });

  it("applies the decay formula on subsequent samples", () => {
    let state = foldEwmaSample(initEwmaState(), sample(10), 0.5);
    state = foldEwmaSample(state, sample(20, "stale", 2_000), 0.5);
    expect(state.value).toBe(15);
    expect(state.lastInputQuality).toBe("stale");
  });

  it("returns the same state reference for unusable samples", () => {
    const seeded = foldEwmaSample(initEwmaState(), sample(10), 0.5);
    expect(foldEwmaSample(seeded, sample(99, "bad"), 0.5)).toBe(seeded);
    expect(foldEwmaSample(seeded, sample(null), 0.5)).toBe(seeded);
    expect(foldEwmaSample(seeded, sample(Number.NaN), 0.5)).toBe(seeded);
  });
});

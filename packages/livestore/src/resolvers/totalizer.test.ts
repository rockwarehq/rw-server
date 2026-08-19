import { describe, expect, it } from "vitest";

import { foldTotalizerReset, foldTotalizerSource, foldTotalizerTrigger, initTotalizerState } from "./totalizer.js";
import type { GraphHookCondition } from "../catalog/hook-conditions.js";
import type { Quality, ValueEnvelope } from "../types/index.js";

const sample = (value: unknown, quality: Quality = "good", timestamp = 1000): ValueEnvelope => ({
  value,
  quality,
  timestamp,
});

describe("totalizer folds", () => {
  const trigger = (overrides: Partial<GraphHookCondition> = {}): GraphHookCondition => ({
    source: { type: "property", propertyId: "trig" },
    operator: "changed",
    ...overrides,
  });

  it("tracks the newest usable source value and drops unusable ones", () => {
    let state = foldTotalizerSource(initTotalizerState(), sample(4.2, "stale", 1_000));
    expect(state).toMatchObject({ latestSourceValue: 4.2, latestSourceQuality: "stale" });
    expect(foldTotalizerSource(state, sample(null, "bad", 2_000))).toBe(state);
    state = foldTotalizerSource(state, sample(5, "good", 3_000));
    expect(state).toMatchObject({ latestSourceValue: 5, latestSourceQuality: "good" });
  });

  it("adds the latest source value on every fired trigger", () => {
    let state = foldTotalizerSource(initTotalizerState(), sample(100, "good", 1_000));
    state = foldTotalizerTrigger(state, sample(0, "good", 1_500), trigger()).state; // baseline
    const first = foldTotalizerTrigger(state, sample(1, "good", 2_000), trigger());
    expect(first).toMatchObject({ added: true, skipped: false });
    const second = foldTotalizerTrigger(first.state, sample(2, "good", 3_000), trigger());
    expect(second.state).toMatchObject({ total: 200, count: 2, lastTriggerTs: 3_000 });
  });

  it("skips (without adding) when the trigger fires before any usable source value", () => {
    const baseline = foldTotalizerTrigger(initTotalizerState(), sample(0, "good", 500), trigger());
    const result = foldTotalizerTrigger(baseline.state, sample(1, "good", 1_000), trigger());
    expect(result).toMatchObject({ added: false, skipped: true });
    expect(result.state).toMatchObject({ total: 0, count: 0, lastTriggerTs: 1_000 });
  });

  it("rising edge fires only on the 0-to-nonzero transition", () => {
    const rising = trigger({ operator: "crossesAbove", threshold: 0.5 });
    const state = foldTotalizerSource(initTotalizerState(), sample(7, "good", 500));
    // No baseline yet: the first sample cannot be an edge.
    let result = foldTotalizerTrigger(state, sample(1, "good", 1_000), rising);
    expect(result.added).toBe(false);
    result = foldTotalizerTrigger(result.state, sample(0, "good", 2_000), rising);
    expect(result.added).toBe(false);
    result = foldTotalizerTrigger(result.state, sample(1, "good", 3_000), rising);
    expect(result).toMatchObject({ added: true });
    expect(result.state.total).toBe(7);
    // Level stays high: no re-fire.
    result = foldTotalizerTrigger(result.state, sample(1, "good", 4_000), rising);
    expect(result.added).toBe(false);
  });

  it("compares edges against the last GOOD trigger sample across quality flaps", () => {
    const rising = trigger({ operator: "crossesAbove", threshold: 0.5 });
    let state = foldTotalizerSource(initTotalizerState(), sample(7, "good", 500));
    state = foldTotalizerTrigger(state, sample(1, "good", 1_000), rising).state;
    // Dropout while high: bad sample neither fires nor becomes the baseline.
    let result = foldTotalizerTrigger(state, sample(0, "bad", 2_000), rising);
    expect(result.added).toBe(false);
    expect(result.state.lastTriggerValue).toBe(1);
    // Recovery still high: baseline was 1, so no fake edge.
    result = foldTotalizerTrigger(result.state, sample(1, "good", 3_000), rising);
    expect(result.added).toBe(false);
  });

  it("on-change ignores repeated values and non-good samples", () => {
    const onChange = trigger({ operator: "changed" });
    let state = foldTotalizerSource(initTotalizerState(), sample(4, "good", 500));
    state = foldTotalizerTrigger(state, sample(4, "good", 1_000), onChange).state; // baseline
    let result = foldTotalizerTrigger(state, sample(4, "good", 2_000), onChange);
    expect(result.added).toBe(false);
    result = foldTotalizerTrigger(result.state, sample(5, "good", 3_000), onChange);
    expect(result.added).toBe(true);
    expect(result.state.total).toBe(4);
  });

  it("propagates the worst input quality into lastQuality", () => {
    let state = foldTotalizerSource(initTotalizerState(), sample(10, "uncertain", 500));
    state = foldTotalizerTrigger(state, sample(0, "good", 800), trigger()).state; // baseline
    const result = foldTotalizerTrigger(state, sample(1, "good", 1_000), trigger());
    expect(result.state.lastQuality).toBe("uncertain");
  });

  const resetCondition = (overrides: Partial<GraphHookCondition> = {}): GraphHookCondition => ({
    source: { type: "property", propertyId: "shift" },
    operator: "changed",
    ...overrides,
  });

  it("zeroes total and count when the reset condition fires", () => {
    let state = foldTotalizerSource(initTotalizerState(), sample(100, "good", 500));
    state = foldTotalizerTrigger(state, sample(0, "good", 800), trigger()).state; // baseline
    state = foldTotalizerTrigger(state, sample(1, "good", 1_000), trigger()).state;
    state = foldTotalizerReset(state, sample("shift-a", "good", 1_500), resetCondition()).state; // baseline
    expect(state).toMatchObject({ total: 100, count: 1 });
    const result = foldTotalizerReset(state, sample("shift-b", "good", 2_000), resetCondition());
    expect(result.reset).toBe(true);
    expect(result.state).toMatchObject({ total: 0, count: 0, lastResetValue: "shift-b", lastResetTs: 2_000 });
    // Source tracking survives the reset: the next trigger adds into the new period.
    const next = foldTotalizerTrigger(result.state, sample(2, "good", 3_000), trigger());
    expect(next.state).toMatchObject({ total: 100, count: 1 });
  });

  it("treats the first reset sample as a baseline (no reset at boot)", () => {
    let state = foldTotalizerSource(initTotalizerState(), sample(100, "good", 500));
    state = foldTotalizerTrigger(state, sample(0, "good", 800), trigger()).state;
    state = foldTotalizerTrigger(state, sample(1, "good", 1_000), trigger()).state;
    const result = foldTotalizerReset(state, sample("shift-a", "good", 1_500), resetCondition());
    expect(result.reset).toBe(false);
    expect(result.state).toMatchObject({ total: 100, lastResetValue: "shift-a", lastResetTs: 1_500 });
  });

  it("compares resets against the last GOOD reset sample across quality flaps", () => {
    let state = foldTotalizerReset(initTotalizerState(), sample("shift-a", "good", 1_000), resetCondition()).state;
    state = { ...state, total: 50, count: 5 };
    // Bad sample neither fires nor moves the baseline.
    let result = foldTotalizerReset(state, sample("shift-b", "bad", 2_000), resetCondition());
    expect(result.reset).toBe(false);
    expect(result.state.lastResetValue).toBe("shift-a");
    result = foldTotalizerReset(result.state, sample("shift-b", "good", 3_000), resetCondition());
    expect(result.reset).toBe(true);
  });
});

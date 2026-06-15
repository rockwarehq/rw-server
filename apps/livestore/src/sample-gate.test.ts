import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SampleGate } from "./sample-gate.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sample gate", () => {
  it("never defers a property that has not evaluated yet", () => {
    const gate = new SampleGate(() => {});
    expect(gate.shouldDefer("a", 1000)).toBe(false);
  });

  it("never defers without a sampleRateMs", () => {
    const gate = new SampleGate(() => {});
    gate.recordEvaluated("a");
    expect(gate.shouldDefer("a", null)).toBe(false);
  });

  it("defers within the window and re-marks when it expires", () => {
    const remarked: string[] = [];
    const gate = new SampleGate((id) => remarked.push(id));
    gate.recordEvaluated("a");

    vi.advanceTimersByTime(400);
    expect(gate.shouldDefer("a", 1000)).toBe(true);

    vi.advanceTimersByTime(599);
    expect(remarked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(remarked).toEqual(["a"]);
  });

  it("allows evaluation again once the window has passed", () => {
    const gate = new SampleGate(() => {});
    gate.recordEvaluated("a");
    vi.advanceTimersByTime(1000);
    expect(gate.shouldDefer("a", 1000)).toBe(false);
  });

  it("a burst of deferrals arms only one timer", () => {
    const remarked: string[] = [];
    const gate = new SampleGate((id) => remarked.push(id));
    gate.recordEvaluated("a");

    for (let i = 0; i < 5; i++) expect(gate.shouldDefer("a", 1000)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(remarked).toEqual(["a"]);
  });

  it("tracks properties independently", () => {
    const gate = new SampleGate(() => {});
    gate.recordEvaluated("a");
    expect(gate.shouldDefer("a", 1000)).toBe(true);
    expect(gate.shouldDefer("b", 1000)).toBe(false);
  });

  it("stop cancels pending re-marks", () => {
    const remarked: string[] = [];
    const gate = new SampleGate((id) => remarked.push(id));
    gate.recordEvaluated("a");
    gate.shouldDefer("a", 1000);

    gate.stop();
    vi.advanceTimersByTime(2000);
    expect(remarked).toEqual([]);
  });
});

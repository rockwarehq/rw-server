import { describe, expect, it } from "vitest";
import type { GraphHookCondition } from "../catalog/hook-conditions.js";

import { evaluateHookCondition } from "./hook-condition.js";
import type { Quality, ValueEnvelope } from "../types/index.js";

const env = (value: unknown, quality: Quality = "good"): ValueEnvelope => ({
  value,
  quality,
  timestamp: 1000,
});

const condition = (overrides: Partial<GraphHookCondition>): GraphHookCondition => ({
  source: { type: "property", propertyId: "prop-1" },
  operator: "changed",
  ...overrides,
});

describe("evaluateHookCondition", () => {
  it("matches numeric increases with an optional minDelta", () => {
    expect(evaluateHookCondition(condition({ operator: "increases" }), env(10), env(11))).toBe(true);
    expect(evaluateHookCondition(condition({ operator: "increases", minDelta: 2 }), env(10), env(11))).toBe(false);
    expect(evaluateHookCondition(condition({ operator: "increases", minDelta: 1 }), env(10), env(11))).toBe(true);
  });

  it("requires good quality for edge conditions", () => {
    expect(evaluateHookCondition(condition({ operator: "increases" }), env(10, "stale"), env(11))).toBe(false);
    expect(evaluateHookCondition(condition({ operator: "increases" }), env(10), env(11, "uncertain"))).toBe(false);
  });

  it("matches threshold comparisons on current values", () => {
    expect(evaluateHookCondition(condition({ operator: "gt", threshold: 100 }), env(50, "bad"), env(101))).toBe(true);
    expect(evaluateHookCondition(condition({ operator: "lte", threshold: 100 }), env(50, "bad"), env(101))).toBe(false);
  });

  it("matches threshold crossings using previous and current values", () => {
    expect(evaluateHookCondition(condition({ operator: "crossesAbove", threshold: 100 }), env(100), env(101))).toBe(
      true,
    );
    expect(evaluateHookCondition(condition({ operator: "crossesAbove", threshold: 100 }), env(101), env(102))).toBe(
      false,
    );
    expect(evaluateHookCondition(condition({ operator: "crossesBelow", threshold: 100 }), env(100), env(99))).toBe(
      true,
    );
  });

  it("matches equality operators against the configured value", () => {
    expect(
      evaluateHookCondition(condition({ operator: "equals", value: "RUNNING" }), env("IDLE"), env("RUNNING")),
    ).toBe(true);
    expect(
      evaluateHookCondition(condition({ operator: "notEquals", value: "RUNNING" }), env("IDLE"), env("IDLE")),
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { defaultStationSim, stationSimSchema, type Step } from "./config.js";
import { AUTO_PROFILES, advanceCursor, newCursor, pickAutoStretch, planCycle, seededRng } from "./program.js";

const fixed = (v: number) => () => v;
const MIN = 60_000;

describe("planCycle", () => {
  const discrete = { mode: "DISCRETE" as const, standardCycleSeconds: 30, standardQuantity: null };

  it("divides cycle time by the rate multiplier", () => {
    // rng 0.5 → zero noise
    expect(planCycle(discrete, 1, 0.03, fixed(0.5)).delayMs).toBeCloseTo(30_000);
    expect(planCycle(discrete, 1.2, 0.03, fixed(0.5)).delayMs).toBeCloseTo(25_000);
    expect(planCycle(discrete, 0.8, 0.03, fixed(0.5)).delayMs).toBeCloseTo(37_500);
  });

  it("applies jitter within ±jitter", () => {
    expect(planCycle(discrete, 1, 0.1, fixed(0)).delayMs).toBeCloseTo(27_000);
    expect(planCycle(discrete, 1, 0.1, fixed(1)).delayMs).toBeCloseTo(33_000);
  });

  it("count by time keeps the interval and scales the count", () => {
    const perInterval = { mode: "QUANTITY_PER_INTERVAL" as const, standardCycleSeconds: 60, standardQuantity: 100 };
    const plan = planCycle(perInterval, 1.2, 0.03, fixed(0.5));
    expect(plan.delayMs).toBe(60_000);
    expect(plan.quantity).toBe(120);
  });
});

describe("advanceCursor", () => {
  const alternating: Step[] = [
    { type: "rate", rate: 1.2, jitter: 0.03, durationSec: 600 },
    { type: "rate", rate: 0.8, jitter: 0.03, durationSec: 600 },
  ];

  it("moves to the next step once its time is up, and loops forever", () => {
    let c = newCursor(0);
    c = advanceCursor(alternating, c, 9 * MIN);
    expect(c.index).toBe(0);
    c = advanceCursor(alternating, c, 10 * MIN);
    expect(c.index).toBe(1);
    c = advanceCursor(alternating, c, 20 * MIN);
    expect(c.index).toBe(0);
  });

  it("keeps step boundaries on schedule when checked late", () => {
    expect(advanceCursor(alternating, newCursor(0), 10 * MIN + 5_000)).toEqual({ index: 1, startedAt: 10 * MIN });
  });

  it("a step without a duration holds", () => {
    const steps: Step[] = [{ type: "stop" }, { type: "rate", rate: 1, jitter: 0 }];
    expect(advanceCursor(steps, newCursor(0), 1e12).index).toBe(0);
  });
});

describe("pickAutoStretch", () => {
  it("only picks states with weight", () => {
    const rng = seededRng(1);
    for (let i = 0; i < 50; i++) {
      const s = pickAutoStretch({ great: 0, normal: 0, slow: 1, microstop: 0, down: 0 }, 0, rng);
      expect(s.state).toBe("slow");
      expect(s.rate).toBeGreaterThanOrEqual(AUTO_PROFILES.slow.rate[0]);
      expect(s.endsAt).toBeGreaterThanOrEqual(AUTO_PROFILES.slow.dwell[0] * 1000);
    }
  });

  it("down stretches don't cycle", () => {
    expect(pickAutoStretch({ great: 0, normal: 0, slow: 0, microstop: 0, down: 1 }, 0, fixed(0.3)).rate).toBe(0);
  });
});

describe("stationSimSchema", () => {
  it("defaults to disabled auto at standard rate", () => {
    expect(defaultStationSim()).toMatchObject({ enabled: false, mode: "auto", steps: [{ type: "rate", rate: 1 }] });
  });

  it("fills a step's jitter when left out", () => {
    const sim = stationSimSchema.parse({ mode: "program", steps: [{ type: "rate", rate: 1.2 }] });
    expect(sim.steps[0]).toEqual({ type: "rate", rate: 1.2, jitter: 0.03 });
  });
});

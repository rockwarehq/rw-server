import { describe, expect, it } from "vitest";
import {
  quantityWasSlow,
  resolveCycleActuals,
  resolveStandards,
  type StandardsConfig,
} from "./standards.js";

const base: StandardsConfig = {
  cycleMode: "DISCRETE",
  stationStandardQuantity: null,
  stationQuantityUnit: "",
  stationStandardCycle: null,
  stationStandardRate: null,
  stationStandardRateUnit: "",
  stationStandardRatePeriod: "MINUTE",
  jobStandardCycle: null,
  jobStandardRate: null,
  jobStandardRateUnit: "",
  jobStandardRatePeriod: "MINUTE",
  jobStandardQuantity: null,
};

describe("DISCRETE — must match today's behavior exactly", () => {
  it("resolves the job's entered standardCycle, untouched", () => {
    const std = resolveStandards({ ...base, jobStandardCycle: 30 });
    expect(std.standardCycleSeconds).toBe(30);
    expect(std.standardQuantity).toBeNull();
    expect(std.secondsPerUnit).toBeNull();
  });

  it("stamp: earned = the flat standard; quantity = measured passthrough", () => {
    const std = resolveStandards({ ...base, jobStandardCycle: 30 });
    expect(resolveCycleActuals(std, null)).toMatchObject({ quantity: null, standardCycle: 30 });
    expect(resolveCycleActuals(std, 12.5)).toMatchObject({ quantity: 12.5, standardCycle: 30 });
  });

  it("no standardCycle configured → nulls (today's null flow)", () => {
    const std = resolveStandards(base);
    expect(std.standardCycleSeconds).toBeNull();
    expect(resolveCycleActuals(std, null).standardCycle).toBeNull();
  });

  it("rate fields on the job are ignored in DISCRETE", () => {
    const std = resolveStandards({ ...base, jobStandardCycle: 30, jobStandardRate: 50, jobStandardRateUnit: "ft" });
    expect(std.standardCycleSeconds).toBe(30);
    expect(std.standardQuantity).toBeNull();
  });

  it("never quantity-slow", () => {
    const std = resolveStandards({ ...base, jobStandardCycle: 30 });
    expect(quantityWasSlow(std, 1, 0.5)).toBe(false);
  });
});

describe("QUANTITY_PER_CYCLE — pulse case (100 ft every tick)", () => {
  const cfg: StandardsConfig = {
    ...base,
    cycleMode: "QUANTITY_PER_CYCLE",
    stationStandardQuantity: 100,
    stationQuantityUnit: "ft",
    jobStandardRate: 50,
    jobStandardRateUnit: "ft",
    jobStandardRatePeriod: "MINUTE",
  };

  it("derives standardCycle = pulse ÷ rate (100 ft ÷ 50 ft/min = 120 s)", () => {
    const std = resolveStandards(cfg);
    expect(std.standardCycleSeconds).toBeCloseTo(120, 10);
    expect(std.standardQuantity).toBe(100);
    expect(std.quantityUnit).toBe("ft");
  });

  it("no measured quantity → cycle assumes the pulse; earned = full standard", () => {
    const std = resolveStandards(cfg);
    expect(resolveCycleActuals(std, null)).toMatchObject({ quantity: 100, standardCycle: 120 });
  });

  it("measured quantity wins; earned scales with it", () => {
    const std = resolveStandards(cfg);
    const actuals = resolveCycleActuals(std, 87);
    expect(actuals.quantity).toBe(87);
    expect(actuals.standardCycle).toBeCloseTo(87 * 1.2, 10);
  });

  it("job-level standardQuantity overrides the station pulse", () => {
    const std = resolveStandards({ ...cfg, jobStandardQuantity: 250 });
    expect(std.standardQuantity).toBe(250);
    expect(std.standardCycleSeconds).toBeCloseTo(300, 10);
  });

  it("station-level rate works with no job rate; job rate overrides it", () => {
    const stationRate = { ...cfg, jobStandardRate: null, stationStandardRate: 50, stationStandardRateUnit: "ft" };
    expect(resolveStandards(stationRate).standardCycleSeconds).toBeCloseTo(120, 10);
    // Job rate (25 ft/min) beats the station default (50 ft/min).
    const overridden = { ...stationRate, jobStandardRate: 25, jobStandardRateUnit: "ft" };
    expect(resolveStandards(overridden).standardCycleSeconds).toBeCloseTo(240, 10);
  });

  it("rate entered in meters on a feet station converts", () => {
    const std = resolveStandards({ ...cfg, jobStandardRate: 15.24, jobStandardRateUnit: "m" });
    expect(std.standardCycleSeconds).toBeCloseTo(120, 6);
  });

  it("no rate → falls back to a directly-entered job standardCycle", () => {
    const std = resolveStandards({ ...cfg, jobStandardRate: null, jobStandardCycle: 110 });
    expect(std.standardCycleSeconds).toBe(110);
    expect(resolveCycleActuals(std, null).standardCycle).toBe(110);
  });

  it("incompatible rate unit → unusable rate, falls back like no rate", () => {
    const std = resolveStandards({ ...cfg, jobStandardRateUnit: "kg", jobStandardCycle: 110 });
    expect(std.secondsPerUnit).toBeNull();
    expect(std.standardCycleSeconds).toBe(110);
  });
});

describe("QUANTITY_PER_INTERVAL — fixed clock, variable quantity (500/min)", () => {
  const cfg: StandardsConfig = {
    ...base,
    cycleMode: "QUANTITY_PER_INTERVAL",
    stationStandardCycle: 60,
    stationQuantityUnit: "ea",
    jobStandardRate: 500,
    jobStandardRateUnit: "ea",
    jobStandardRatePeriod: "MINUTE",
  };

  it("standardCycle = the interval; expected quantity = rate × interval", () => {
    const std = resolveStandards(cfg);
    expect(std.standardCycleSeconds).toBe(60);
    expect(std.standardQuantity).toBeCloseTo(500, 10);
  });

  it("earned = measured × secondsPerUnit (200 rivets → 24 s of a 60 s tick)", () => {
    const std = resolveStandards(cfg);
    const actuals = resolveCycleActuals(std, 200);
    expect(actuals.quantity).toBe(200);
    expect(actuals.standardCycle).toBeCloseTo(24, 10);
  });

  it("full-rate interval earns the full interval", () => {
    const std = resolveStandards(cfg);
    expect(resolveCycleActuals(std, 500).standardCycle).toBeCloseTo(60, 10);
  });

  it("no measured quantity → earned nothing (no assumption)", () => {
    const std = resolveStandards(cfg);
    expect(resolveCycleActuals(std, null)).toMatchObject({ quantity: null, standardCycle: null });
  });

  it("job-level standardCycle overrides the station tick length", () => {
    const std = resolveStandards({ ...cfg, jobStandardCycle: 30 });
    expect(std.standardCycleSeconds).toBe(30);
    // Expected quantity follows the effective interval: 30 s at 500/min = 250.
    expect(std.standardQuantity).toBeCloseTo(250, 10);
  });

  it("station-level rate: 100 rivets/min on a 60 s tick, no job config", () => {
    const std = resolveStandards({
      ...cfg,
      jobStandardRate: null,
      stationStandardRate: 100,
      stationStandardRateUnit: "ea",
      stationStandardRatePeriod: "MINUTE",
    });
    expect(std.standardQuantity).toBeCloseTo(100, 10);
    expect(resolveCycleActuals(std, 40).standardCycle).toBeCloseTo(24, 10);
  });

  it("no rate anywhere: per-tick standardQuantity (job override, else station)", () => {
    const noRate = { ...cfg, jobStandardRate: null };
    const std = resolveStandards({ ...noRate, stationStandardQuantity: 500 });
    expect(std.standardQuantity).toBe(500);
    // Derived time-per-unit keeps earned time working: 200 made → 24 s earned.
    expect(resolveCycleActuals(std, 200).standardCycle).toBeCloseTo(24, 10);
    // Job override beats the station default.
    const overridden = resolveStandards({ ...noRate, stationStandardQuantity: 500, jobStandardQuantity: 250 });
    expect(overridden.standardQuantity).toBe(250);
  });

  it("slow by quantity shortfall, not lateness", () => {
    const std = resolveStandards(cfg);
    // 500 expected, 25% slow tolerance: slow below 400
    expect(quantityWasSlow(std, 200, 0.25)).toBe(true);
    expect(quantityWasSlow(std, 450, 0.25)).toBe(false);
    expect(quantityWasSlow(std, 200, null)).toBe(false);
    expect(quantityWasSlow(std, null, 0.25)).toBe(false);
  });
});

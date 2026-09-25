import { describe, expect, it } from "vitest";
import {
  kindOf,
  kindsMatch,
  planningRate,
  type ProfileSpec,
  speedDisplay,
  stationFieldsFromProfile,
  validateProfile,
} from "./rules.js";

const press: ProfileSpec = {
  cycleMode: "DISCRETE",
  quantityUnit: "",
  signalAmount: null,
  signalInterval: null,
  countedAs: "CYCLES",
  standardCycle: 28,
  standardRate: null,
  standardRateUnit: "",
  standardRatePeriod: "MINUTE",
};

const extruder: ProfileSpec = {
  ...press,
  cycleMode: "QUANTITY_PER_CYCLE",
  quantityUnit: "ft",
  signalAmount: 100,
  countedAs: "OUTPUT",
  standardCycle: null,
  standardRate: 45,
  standardRateUnit: "ft",
};

const header: ProfileSpec = {
  ...press,
  cycleMode: "QUANTITY_PER_INTERVAL",
  quantityUnit: "ea",
  signalInterval: 60,
  countedAs: "OUTPUT",
  standardCycle: null,
  standardRate: 400,
  standardRateUnit: "ea",
};

describe("validateProfile", () => {
  it("count by amount needs an amount per signal and a unit", () => {
    expect(validateProfile({ ...extruder, signalAmount: null })).toMatchObject({ code: "PROFILE_AMOUNT_REQUIRED" });
    expect(validateProfile({ ...extruder, quantityUnit: "" })).toMatchObject({ code: "PROFILE_UNIT_REQUIRED" });
  });

  it("count by time needs a report interval", () => {
    expect(validateProfile({ ...header, signalInterval: 0 })).toMatchObject({ code: "PROFILE_INTERVAL_REQUIRED" });
  });

  it("clears fields that don't apply to the kind", () => {
    const res = validateProfile({ ...press, signalAmount: 5, signalInterval: 9, standardRate: 10 });
    expect(res).toMatchObject({ data: { signalAmount: null, signalInterval: null, standardRate: null } });
    const amt = validateProfile({ ...extruder, standardCycle: 30, countedAs: "CYCLES" });
    expect(amt).toMatchObject({ data: { standardCycle: null, countedAs: "OUTPUT" } });
  });

  it("refuses a rate in a unit of another kind", () => {
    expect(validateProfile({ ...extruder, standardRateUnit: "kg" })).toMatchObject({ code: "SPEED_UNIT_MISMATCH" });
    // Same kind (length) is fine.
    expect(validateProfile({ ...extruder, standardRateUnit: "m" })).toHaveProperty("data");
  });
});

describe("stationFieldsFromProfile keeps each StationVersion field's engine meaning", () => {
  it("count by cycle: the speed goes in standardCycle", () => {
    expect(stationFieldsFromProfile("p", press, null)).toMatchObject({
      cycleMode: "DISCRETE",
      standardCycle: 28,
      standardQuantity: null,
      standardRate: null,
      speedFromProfile: true,
    });
  });

  it("count by amount: amount per signal in standardQuantity, speed as a rate", () => {
    expect(stationFieldsFromProfile("p", extruder, null)).toMatchObject({
      standardQuantity: 100,
      standardCycle: null,
      standardRate: 45,
      quantityUnit: "ft",
    });
  });

  it("count by time: interval in standardCycle; the station's own rate wins", () => {
    const own = {
      standardCycle: null,
      standardRate: 300,
      standardRateUnit: "ea",
      standardRatePeriod: "MINUTE" as const,
    };
    expect(stationFieldsFromProfile("p", header, own)).toMatchObject({
      standardCycle: 60,
      standardQuantity: null,
      standardRate: 300,
      speedFromProfile: false,
    });
  });
});

describe("kindsMatch — where a job can run", () => {
  it("same way of counting, units of the same kind", () => {
    const job = kindOf("QUANTITY_PER_CYCLE", null, "ft");
    expect(kindsMatch(job, kindOf("QUANTITY_PER_CYCLE", null, "m"))).toBe(true);
    expect(kindsMatch(job, kindOf("QUANTITY_PER_CYCLE", null, "lb"))).toBe(false);
    expect(kindsMatch(job, kindOf("DISCRETE", null, ""))).toBe(false);
  });

  it("count by time: parts and strokes don't mix", () => {
    expect(
      kindsMatch(kindOf("QUANTITY_PER_INTERVAL", "OUTPUT", "ea"), kindOf("QUANTITY_PER_INTERVAL", "CYCLES", "ea")),
    ).toBe(false);
  });

  it("a station with no profile only checks the way of counting and unit", () => {
    const station = { cycleMode: "QUANTITY_PER_INTERVAL" as const, countedAs: null, quantityUnit: "ea" };
    expect(kindsMatch(kindOf("QUANTITY_PER_INTERVAL", "OUTPUT", "ea"), station)).toBe(true);
  });
});

describe("speedDisplay", () => {
  it("cycle time for count by cycle; a rate otherwise", () => {
    expect(speedDisplay(press)).toEqual({ shape: "CYCLE_TIME", unit: "s", period: "SECOND" });
    expect(speedDisplay(extruder)).toEqual({ shape: "RATE", unit: "ft", period: "MINUTE" });
    expect(speedDisplay({ ...header, countedAs: "CYCLES" })).toMatchObject({ unit: "strokes" });
  });
});

describe("planningRate — a job's target with no station", () => {
  const noSpeed = {
    standardCycle: null,
    standardRate: null,
    standardRateUnit: "",
    standardRatePeriod: "MINUTE" as const,
  };

  it("press: 28 s × 4 cavities ≈ 514 parts/hour", () => {
    const r = planningRate(press, noSpeed, 4);
    expect(r.source).toBe("PROFILE");
    expect(r.outputPerHour).toBeCloseTo((3600 / 28) * 4, 6);
  });

  it("the job's own speed wins over the profile's", () => {
    const r = planningRate(press, { ...noSpeed, standardCycle: 20 }, 1);
    expect(r.source).toBe("JOB");
    expect(r.countsPerHour).toBeCloseTo(180, 6);
  });

  it("extruder: 45 ft/min = 2,700 ft/hour, whatever the encoder's step", () => {
    expect(planningRate(extruder, noSpeed, 1).outputPerHour).toBeCloseTo(2700, 6);
    expect(planningRate({ ...extruder, signalAmount: 50 }, noSpeed, 1).outputPerHour).toBeCloseTo(2700, 6);
  });

  it("header: 400 pcs/min = 24,000 pcs/hour", () => {
    expect(planningRate(header, noSpeed, 1).outputPerHour).toBeCloseTo(24000, 6);
  });

  it("strokes × parts per stroke", () => {
    const strokes = { ...header, countedAs: "CYCLES" as const, standardRate: 120 };
    expect(planningRate(strokes, noSpeed, 3).outputPerHour).toBeCloseTo(120 * 60 * 3, 6);
  });

  it("no speed anywhere → no target", () => {
    expect(planningRate({ ...press, standardCycle: null }, noSpeed, 1)).toMatchObject({
      source: null,
      outputPerHour: null,
    });
  });
});

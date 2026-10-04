import { describe, expect, it } from "vitest";
import { type StationSpeedInput, stationSpeed } from "./speed.js";

const start = new Date("2026-10-03T02:20:05.790Z");
const endAt = (ms: number) => new Date(start.getTime() + ms);

// Trimlok Line1: count by amount, 30 ft per signal, 130 ft/min standard.
const extruder: StationSpeedInput = {
  cycleMode: "QUANTITY_PER_CYCLE",
  quantityUnit: "ft",
  countedAs: "OUTPUT",
  ratePeriod: "MINUTE",
  lastCycle: { start, end: endAt(31_736), quantity: 30 },
  secondsPerUnit: 0.4615001215283654,
  standardCycleSeconds: 13.845,
};

const press: StationSpeedInput = {
  cycleMode: "DISCRETE",
  quantityUnit: "",
  countedAs: "CYCLES",
  ratePeriod: "MINUTE",
  lastCycle: { start, end: endAt(28_449), quantity: null },
  secondsPerUnit: null,
  standardCycleSeconds: 28,
};

describe("stationSpeed", () => {
  it("rates count by amount from the cycle's own quantity and exact seconds", () => {
    expect(stationSpeed(extruder)).toEqual({
      speedShape: "RATE",
      speedUnit: "ft",
      speedPeriod: "MINUTE",
      currentSpeed: 56.7, // 30 × 60 / 31.736
      standardSpeed: 130,
    });
  });

  it("uses the period it is given", () => {
    const s = stationSpeed({ ...extruder, ratePeriod: "HOUR" });
    expect(s.speedPeriod).toBe("HOUR");
    expect(s.currentSpeed).toBe(3403.1);
    expect(s.standardSpeed).toBe(7800.6);
  });

  it("shows count by cycle as cycle time", () => {
    expect(stationSpeed(press)).toEqual({
      speedShape: "CYCLE_TIME",
      speedUnit: "s",
      speedPeriod: "SECOND",
      currentSpeed: 28.4,
      standardSpeed: 28,
    });
  });

  it("shows count by time in strokes, or in the unit when counting output", () => {
    const interval: StationSpeedInput = {
      ...extruder,
      cycleMode: "QUANTITY_PER_INTERVAL",
      quantityUnit: "ea",
      countedAs: "CYCLES",
      lastCycle: { start, end: endAt(60_000), quantity: 42 },
      secondsPerUnit: 1.5,
    };
    expect(stationSpeed(interval)).toMatchObject({ speedUnit: "strokes", currentSpeed: 42, standardSpeed: 40 });
    expect(stationSpeed({ ...interval, countedAs: "OUTPUT" }).speedUnit).toBe("ea");
    // No profile: count by time reads as strokes.
    expect(stationSpeed({ ...interval, countedAs: null }).speedUnit).toBe("strokes");
  });

  describe("never divides by zero or returns Infinity/NaN", () => {
    it.each([
      ["zero-length cycle", { lastCycle: { start, end: start, quantity: 30 } }],
      ["cycle ending before it starts", { lastCycle: { start, end: endAt(-5_000), quantity: 30 } }],
      ["open cycle", { lastCycle: { start, end: null, quantity: 30 } }],
      ["no cycle yet", { lastCycle: null }],
      ["no quantity", { lastCycle: { start, end: endAt(31_736), quantity: null } }],
      ["negative quantity", { lastCycle: { start, end: endAt(31_736), quantity: -30 } }],
      ["NaN quantity", { lastCycle: { start, end: endAt(31_736), quantity: Number.NaN } }],
      ["invalid date", { lastCycle: { start: new Date("nope"), end: endAt(31_736), quantity: 30 } }],
    ] as const)("current speed is null for a %s", (_, patch) => {
      const s = stationSpeed({ ...extruder, ...patch } as StationSpeedInput);
      expect(s.currentSpeed).toBeNull();
      expect(s.standardSpeed).toBe(130);
    });

    it.each([
      ["zero", 0],
      ["negative", -1],
      ["missing", null],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["NaN", Number.NaN],
    ])("standard speed is null for a %s seconds per unit", (_, secondsPerUnit) => {
      const s = stationSpeed({ ...extruder, secondsPerUnit });
      expect(s.standardSpeed).toBeNull();
      expect(s.currentSpeed).toBe(56.7);
    });

    it("gives zero, not null, for a cycle that made nothing", () => {
      expect(stationSpeed({ ...extruder, lastCycle: { start, end: endAt(60_000), quantity: 0 } }).currentSpeed).toBe(0);
    });

    it("gives null rates for an unknown stored period", () => {
      const s = stationSpeed({ ...extruder, ratePeriod: "FORTNIGHT" });
      expect(s.currentSpeed).toBeNull();
      expect(s.standardSpeed).toBeNull();
    });

    it("gives null cycle times for zero or missing standards", () => {
      expect(stationSpeed({ ...press, standardCycleSeconds: 0 }).standardSpeed).toBeNull();
      expect(stationSpeed({ ...press, standardCycleSeconds: null }).standardSpeed).toBeNull();
      expect(stationSpeed({ ...press, lastCycle: { start, end: start, quantity: null } }).currentSpeed).toBeNull();
    });

    it("treats a missing cycle mode as count by cycle", () => {
      expect(stationSpeed({ ...press, cycleMode: null }).speedShape).toBe("CYCLE_TIME");
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  DIMENSIONS,
  FACTS,
  factDimensions,
  factMeasures,
  getDimension,
  getFact,
  getMeasure,
  MEASURES,
} from "../catalog.js";
import { formulaFields } from "../formula.js";

describe("catalog integrity", () => {
  const ratioMeasures = Object.values(MEASURES).filter((m) => m.kind === "ratio");

  it("every ratio measure's deps exist and are additive", () => {
    for (const measure of ratioMeasures) {
      expect(measure.deps, `${measure.key}.deps`).toBeDefined();
      for (const dep of measure.deps ?? []) {
        const target = MEASURES[dep];
        expect(target, `${measure.key} dep "${dep}"`).toBeDefined();
        expect(target?.kind, `${measure.key} dep "${dep}" kind`).toBe("additive");
      }
    }
  });

  it("every ratio formula references only dep keys", () => {
    for (const measure of ratioMeasures) {
      expect(measure.formula, `${measure.key}.formula`).toBeDefined();
      const referenced = formulaFields(measure.formula!);
      for (const key of referenced) {
        expect(measure.deps, `${measure.key} formula field "${key}"`).toContain(key);
      }
    }
  });

  it("every ratio guard field is a dep", () => {
    for (const measure of ratioMeasures) {
      for (const key of [measure.guards?.nullWhenZero, measure.guards?.zeroWhenZero]) {
        if (key !== undefined) expect(measure.deps, `${measure.key} guard "${key}"`).toContain(key);
      }
    }
  });

  it("every fact's dimension and measure keys exist", () => {
    for (const fact of Object.values(FACTS)) {
      for (const dim of fact.dimensions) {
        expect(DIMENSIONS[dim], `${fact.key} dimension "${dim}"`).toBeDefined();
      }
      for (const key of Object.keys(fact.dimensionColumns ?? {})) {
        expect(fact.dimensions, `${fact.key} dimensionColumns "${key}"`).toContain(key);
      }
      for (const measure of fact.measures) {
        expect(MEASURES[measure], `${fact.key} measure "${measure}"`).toBeDefined();
      }
    }
  });

  it("additive measures have sql XOR agg:count", () => {
    for (const measure of Object.values(MEASURES)) {
      if (measure.kind !== "additive") continue;
      if (measure.agg === "count") {
        expect(measure.sql, `${measure.key}.sql`).toBeUndefined();
      } else {
        expect(measure.sql, `${measure.key}.sql`).toBeDefined();
      }
    }
  });
});

describe("lookup helpers", () => {
  it("resolve known keys", () => {
    expect(getFact("bucket").table).toBe("MetricBucket");
    expect(getMeasure("oee").kind).toBe("ratio");
    expect(getDimension("station").factColumn).toBe("stationId");
    expect(factMeasures("cycle").map((m) => m.key)).toEqual(["cycleCount", "cycleSeconds", "rejectCount"]);
    expect(factDimensions("downtime").map((d) => d.key)).toEqual(["station", "workcenter", "shift", "businessDate", "job", "reason"]);
  });

  it("throw on unknown keys", () => {
    expect(() => getMeasure("nope")).toThrow('Unknown measure "nope"');
    expect(() => getDimension("nope")).toThrow('Unknown dimension "nope"');
  });
});

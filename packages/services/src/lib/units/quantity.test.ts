import { describe, expect, it } from "vitest";
import { areCompatible, convertQuantity, dimensionOf, secondsPerUnit, secondsPerUnitIn } from "./quantity.js";

describe("dimensionOf", () => {
  it("classifies count, length, and mass units", () => {
    expect(dimensionOf("ea")).toBe("count");
    expect(dimensionOf("ft")).toBe("length");
    expect(dimensionOf("kg")).toBe("mass");
    expect(dimensionOf("FT")).toBe("length"); // case-insensitive
    expect(dimensionOf("")).toBeNull();
    expect(dimensionOf("bananas")).toBeNull();
  });
});

describe("areCompatible", () => {
  it("matches same dimension, rejects cross-dimension", () => {
    expect(areCompatible("ft", "m")).toBe(true);
    expect(areCompatible("kg", "lb")).toBe(true);
    expect(areCompatible("ft", "kg")).toBe(false);
  });

  it("blank/unknown units are only compatible verbatim", () => {
    expect(areCompatible("", "")).toBe(true);
    expect(areCompatible("", "ft")).toBe(false);
    expect(areCompatible("widgets", "widgets")).toBe(true);
    expect(areCompatible("widgets", "ea")).toBe(false);
  });
});

describe("convertQuantity", () => {
  it("converts within a dimension", () => {
    expect(convertQuantity(1, "m", "ft")).toBeCloseTo(3.28084, 4);
    expect(convertQuantity(100, "ft", "m")).toBeCloseTo(30.48, 10);
    expect(convertQuantity(1, "lb", "g")).toBeCloseTo(453.59237, 10);
    expect(convertQuantity(2.5, "kg", "kg")).toBe(2.5);
  });

  it("returns null across dimensions or for unknown units", () => {
    expect(convertQuantity(1, "ft", "kg")).toBeNull();
    expect(convertQuantity(1, "nope", "m")).toBeNull();
  });
});

describe("secondsPerUnit / secondsPerUnitIn", () => {
  it("computes seconds per unit from a rate", () => {
    expect(secondsPerUnit(50, "MINUTE")).toBeCloseTo(1.2, 10); // 50/min → 1.2 s each
    expect(secondsPerUnit(1, "SECOND")).toBe(1);
    expect(secondsPerUnit(3600, "HOUR")).toBe(1);
    expect(secondsPerUnit(0, "MINUTE")).toBeNull();
    expect(secondsPerUnit(-5, "HOUR")).toBeNull();
  });

  it("converts the rate's unit into the target unit", () => {
    // 15.24 m/min ≡ 50 ft/min → 1.2 s per foot
    expect(secondsPerUnitIn(15.24, "m", "MINUTE", "ft")).toBeCloseTo(1.2, 10);
    // Same unit: no conversion
    expect(secondsPerUnitIn(50, "ft", "MINUTE", "ft")).toBeCloseTo(1.2, 10);
    // Blank rate unit inherits the target unit
    expect(secondsPerUnitIn(50, "", "MINUTE", "ft")).toBeCloseTo(1.2, 10);
    // Incompatible dimensions: null
    expect(secondsPerUnitIn(50, "kg", "MINUTE", "ft")).toBeNull();
  });
});

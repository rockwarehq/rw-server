// Quantity-unit conversion over the open vocabulary used by station/job
// quantity config (counts, lengths, masses as lowercase tokens). Pure math —
// plain numbers in and out, callers own rounding; conversion happens at
// write/display boundaries only, stored values keep their recorded unit.
// Complements weight.ts (Decimal-exact material weights, WeightUnit enum).

import { weightFactorsInGrams } from "./weight.js";

export type QuantityDimension = "count" | "length" | "mass";

export type RatePeriod = "SECOND" | "MINUTE" | "HOUR";

interface UnitDef {
  dimension: QuantityDimension;
  /** Multiplier to the dimension's base unit (count: ea, length: m, mass: kg). */
  factor: number;
}

// Mass factors derive from weight.ts (grams base ÷ 1000) — one source of truth.
const massUnits = (): Record<string, UnitDef> => {
  const grams = weightFactorsInGrams();
  return Object.fromEntries(
    Object.entries(grams).map(([token, factor]) => [
      token.toLowerCase(),
      { dimension: "mass" as const, factor: Number(factor) / 1000 },
    ]),
  );
};

/** Canonical unit vocabulary. */
const UNITS: Record<string, UnitDef> = {
  ea: { dimension: "count", factor: 1 },
  m: { dimension: "length", factor: 1 },
  mm: { dimension: "length", factor: 0.001 },
  cm: { dimension: "length", factor: 0.01 },
  km: { dimension: "length", factor: 1000 },
  in: { dimension: "length", factor: 0.0254 },
  ft: { dimension: "length", factor: 0.3048 },
  yd: { dimension: "length", factor: 0.9144 },
  ...massUnits(),
};

const RATE_PERIOD_SECONDS: Record<RatePeriod, number> = {
  SECOND: 1,
  MINUTE: 60,
  HOUR: 3600,
};

/** Dimension of a unit token, or null for unknown/blank units. */
export function dimensionOf(unit: string): QuantityDimension | null {
  return UNITS[normalize(unit)]?.dimension ?? null;
}

/** Blank/unknown units are only compatible verbatim. */
export function areCompatible(from: string, to: string): boolean {
  if (normalize(from) === normalize(to)) return true;
  const a = dimensionOf(from);
  return a !== null && a === dimensionOf(to);
}

/** Convert within a dimension; null when units are unknown or dimensions differ. */
export function convertQuantity(value: number, from: string, to: string): number | null {
  const f = normalize(from);
  const t = normalize(to);
  if (f === t) return value;
  const fromDef = UNITS[f];
  const toDef = UNITS[t];
  if (!fromDef || !toDef || fromDef.dimension !== toDef.dimension) return null;
  return (value * fromDef.factor) / toDef.factor;
}

/** Seconds to produce ONE unit at the given rate ("50/min" → 1.2); null for a non-positive rate. */
export function secondsPerUnit(rate: number, period: RatePeriod): number | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return RATE_PERIOD_SECONDS[period] / rate;
}

/**
 * Seconds to produce ONE `targetUnit` at a rate entered in `rateUnit` — null
 * when the rate is non-positive or units are incompatible; a blank rate unit
 * inherits the target unit.
 */
export function secondsPerUnitIn(
  rate: number,
  rateUnit: string,
  period: RatePeriod,
  targetUnit: string,
): number | null {
  const perUnit = secondsPerUnit(rate, period);
  if (perUnit == null) return null;
  if (normalize(rateUnit) === "" || normalize(rateUnit) === normalize(targetUnit)) return perUnit;
  const oneTargetInRateUnits = convertQuantity(1, targetUnit, rateUnit);
  if (oneTargetInRateUnits == null) return null;
  return perUnit * oneTargetInRateUnits;
}

function normalize(unit: string): string {
  return unit.trim().toLowerCase();
}

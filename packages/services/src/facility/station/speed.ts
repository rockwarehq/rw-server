// A station's live speed in the shape its kind of machine thinks in (ADR-0017
// "What this sets up for later"): cycle time for count by cycle, else a rate
// in the station's unit per the profile's period, e.g. ft/min. Pure, no DB.

import type { CycleModeValue } from "../../cycle/standards.js";
import { type RatePeriod, ratePeriodSeconds } from "../../lib/units/quantity.js";
import { type CountedAs, speedDisplay } from "../station-profile/rules.js";

/** Station entity fields derived here, for entity.changes publishers. */
export const STATION_SPEED_FIELDS = [
  "speedShape",
  "speedUnit",
  "speedPeriod",
  "currentSpeed",
  "standardSpeed",
] as const;
/** The ones that move with each completed cycle. */
export const STATION_LAST_CYCLE_SPEED_FIELDS = ["lastCycleQuantity", "currentSpeed"] as const;

export interface StationSpeedInput {
  cycleMode: CycleModeValue | string | null | undefined;
  quantityUnit: string | null | undefined;
  /** The profile's; null for a station without one (count by time then reads as strokes). */
  countedAs: CountedAs | string | null | undefined;
  /** The profile's rate period, else the station's own. */
  ratePeriod: RatePeriod | string | null | undefined;
  lastCycle: { start: Date; end: Date | null; quantity: number | null } | null;
  /** Effective standard for the running job; null without a job or a usable rate. */
  secondsPerUnit: number | null;
  standardCycleSeconds: number | null;
}

export interface StationSpeed {
  speedShape: "CYCLE_TIME" | "RATE";
  speedUnit: string;
  speedPeriod: RatePeriod;
  /** Last completed cycle: its seconds (cycle time) or quantity per period (rate), to the tenth. */
  currentSpeed: number | null;
  /** The running job's standard, in the same shape, to the tenth. */
  standardSpeed: number | null;
}

/**
 * Every division is guarded: a zero, negative or missing duration, quantity,
 * standard or period gives null, never Infinity or NaN.
 */
export function stationSpeed(input: StationSpeedInput): StationSpeed {
  const mode = (input.cycleMode ?? "DISCRETE") as CycleModeValue;
  const display = speedDisplay({
    cycleMode: mode,
    quantityUnit: input.quantityUnit ?? "",
    countedAs: (input.countedAs ?? null) as CountedAs,
    standardRatePeriod: (input.ratePeriod ?? "MINUTE") as RatePeriod,
  });
  const base = { speedShape: display.shape, speedUnit: display.unit, speedPeriod: display.period };
  const seconds = cycleSeconds(input.lastCycle);

  if (display.shape === "CYCLE_TIME") {
    return {
      ...base,
      currentSpeed: seconds == null ? null : tenth(seconds),
      standardSpeed: tenth(positive(input.standardCycleSeconds)),
    };
  }

  const period = ratePeriodSeconds(display.period);
  const quantity = nonNegative(input.lastCycle?.quantity ?? null);
  const perUnit = positive(input.secondsPerUnit);
  return {
    ...base,
    currentSpeed: period != null && quantity != null && seconds != null ? tenth((quantity * period) / seconds) : null,
    standardSpeed: period != null && perUnit != null ? tenth(period / perUnit) : null,
  };
}

/** Exact seconds of a completed cycle; null when open, zero-length or out of order. */
function cycleSeconds(cycle: StationSpeedInput["lastCycle"]): number | null {
  if (!cycle?.end) return null;
  return positive((cycle.end.getTime() - cycle.start.getTime()) / 1000);
}

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegative(value: number | null): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

function tenth(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

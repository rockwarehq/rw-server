// Station profile rules (ADR-0017). Pure, no DB.
//
// A profile says how a kind of machine counts. Three things hang off it:
//   - which fields a profile needs (validateProfile),
//   - what a station copies from it (stationFieldsFromProfile),
//   - what shape a job's speed takes, and which stations a job fits
//     (validateJobSpeed, kindOf, kindsMatch).

import { resolveStandards, type CycleModeValue } from "../../cycle/standards.js";
import { areCompatible, dimensionOf, type RatePeriod } from "../../lib/units/quantity.js";

export type CountedAs = "OUTPUT" | "CYCLES";

export interface ProfileSpec {
  cycleMode: CycleModeValue;
  quantityUnit: string;
  signalAmount: number | null;
  signalInterval: number | null;
  countedAs: CountedAs;
  standardCycle: number | null;
  standardRate: number | null;
  standardRateUnit: string;
  standardRatePeriod: RatePeriod;
}

/** A speed in the shape its profile uses: seconds per cycle, or amount per time. */
export interface Speed {
  standardCycle: number | null;
  standardRate: number | null;
  standardRateUnit: string;
  standardRatePeriod: RatePeriod;
}

export type RuleError = { error: string; code: string };

/** Speed is a cycle time only when counting by cycle; otherwise a rate. */
export function usesRate(mode: CycleModeValue): boolean {
  return mode !== "DISCRETE";
}

/** Count by cycle is always strokes; count by amount is always output. */
export function effectiveCountedAs(mode: CycleModeValue, countedAs: CountedAs | null | undefined): CountedAs {
  if (mode === "DISCRETE") return "CYCLES";
  if (mode === "QUANTITY_PER_CYCLE") return "OUTPUT";
  return countedAs ?? "CYCLES";
}

/** Check a profile's fields fit its counting kind, and tidy fields that don't apply. */
export function validateProfile(spec: ProfileSpec): RuleError | { data: ProfileSpec } {
  const unit = spec.quantityUnit.trim();
  const out: ProfileSpec = {
    ...spec,
    quantityUnit: unit,
    countedAs: effectiveCountedAs(spec.cycleMode, spec.countedAs),
  };

  if (spec.cycleMode !== "DISCRETE" && dimensionOf(unit) === null) {
    return { error: "Pick the unit this machine counts in", code: "PROFILE_UNIT_REQUIRED" };
  }
  if (unit !== "" && dimensionOf(unit) === null) {
    return { error: `Unknown unit "${unit}"`, code: "PROFILE_UNIT_UNKNOWN" };
  }

  if (spec.cycleMode === "QUANTITY_PER_CYCLE") {
    if (positive(spec.signalAmount) == null) {
      return { error: "Enter how much one signal means (amount per signal)", code: "PROFILE_AMOUNT_REQUIRED" };
    }
  } else {
    out.signalAmount = null;
  }

  if (spec.cycleMode === "QUANTITY_PER_INTERVAL") {
    if (positive(spec.signalInterval) == null) {
      return { error: "Enter how often the machine reports (report every)", code: "PROFILE_INTERVAL_REQUIRED" };
    }
  } else {
    out.signalInterval = null;
  }

  const speed = validateSpeedShape(spec.cycleMode, unit, spec);
  if ("error" in speed) return speed;
  return { data: { ...out, ...speed.data } };
}

/**
 * A speed must match its profile's shape. Count by cycle: seconds, no rate.
 * Otherwise: a rate in a unit of the same kind, no seconds. Fields of the
 * other shape are cleared rather than refused, so switching is forgiving.
 */
export function validateSpeedShape(
  mode: CycleModeValue,
  quantityUnit: string,
  speed: Speed,
): RuleError | { data: Speed } {
  if (!usesRate(mode)) {
    return {
      data: {
        standardCycle: speed.standardCycle,
        standardRate: null,
        standardRateUnit: "",
        standardRatePeriod: speed.standardRatePeriod,
      },
    };
  }
  const rateUnit = speed.standardRate != null ? speed.standardRateUnit.trim() || quantityUnit : "";
  if (speed.standardRate != null && !areCompatible(rateUnit, quantityUnit)) {
    return {
      error: `A rate in "${rateUnit}" does not fit a machine that counts in "${quantityUnit}"`,
      code: "SPEED_UNIT_MISMATCH",
    };
  }
  return {
    data: {
      standardCycle: null,
      standardRate: speed.standardRate,
      standardRateUnit: rateUnit,
      standardRatePeriod: speed.standardRatePeriod,
    },
  };
}

/** The fields a station's version holds when it follows a profile. */
export interface StationProfileFields {
  profileId: string;
  cycleMode: CycleModeValue;
  quantityUnit: string;
  standardQuantity: number | null;
  standardCycle: number | null;
  standardRate: number | null;
  standardRateUnit: string;
  standardRatePeriod: RatePeriod;
  speedFromProfile: boolean;
}

/**
 * What a station copies from its profile. `ownSpeed` is the station's own
 * speed (null = use the profile's usual speed). The cycle engine reads these
 * StationVersion fields, so the mapping keeps each field's engine meaning:
 * standardQuantity is the amount per signal, and standardCycle is the report
 * interval when counting by time, else the cycle time.
 */
export function stationFieldsFromProfile(
  profileId: string,
  profile: ProfileSpec,
  ownSpeed: Speed | null,
): StationProfileFields {
  const speed = ownSpeed ?? profile;
  const base = {
    profileId,
    cycleMode: profile.cycleMode,
    quantityUnit: profile.quantityUnit,
    speedFromProfile: ownSpeed == null,
    standardRatePeriod: speed.standardRatePeriod,
  };
  if (profile.cycleMode === "DISCRETE") {
    return {
      ...base,
      standardQuantity: null,
      standardCycle: speed.standardCycle,
      standardRate: null,
      standardRateUnit: "",
    };
  }
  return {
    ...base,
    standardQuantity: profile.cycleMode === "QUANTITY_PER_CYCLE" ? profile.signalAmount : null,
    standardCycle: profile.cycleMode === "QUANTITY_PER_INTERVAL" ? profile.signalInterval : null,
    standardRate: speed.standardRate,
    standardRateUnit: speed.standardRate != null ? speed.standardRateUnit : "",
  };
}

/** What decides whether a job fits a station. */
export interface CountingKind {
  cycleMode: CycleModeValue;
  countedAs: CountedAs;
  quantityUnit: string;
}

export function kindOf(mode: CycleModeValue, countedAs: CountedAs | null | undefined, unit: string): CountingKind {
  return { cycleMode: mode, countedAs: effectiveCountedAs(mode, countedAs), quantityUnit: unit };
}

/**
 * A job fits a station when both count the same way and in units of the same
 * kind. Profiles need not be the same one: an ft/min job runs on a 100 ft
 * extruder and a 50 ft one alike. `station.countedAs` null = the station has
 * no profile yet, so that part is not checked.
 */
export function kindsMatch(
  job: CountingKind,
  station: CountingKind | (Omit<CountingKind, "countedAs"> & { countedAs: null }),
): boolean {
  if (job.cycleMode !== station.cycleMode) return false;
  if (station.countedAs != null && job.countedAs !== station.countedAs) return false;
  if (job.cycleMode === "DISCRETE") return true;
  return areCompatible(job.quantityUnit, station.quantityUnit);
}

export const COUNT_NAMES: Record<CycleModeValue, string> = {
  DISCRETE: "Count by cycle",
  QUANTITY_PER_CYCLE: "Count by amount",
  QUANTITY_PER_INTERVAL: "Count by time",
};

/** How speed should be shown for this kind of machine (boxscore, timeline, reports later). */
export interface SpeedDisplay {
  shape: "CYCLE_TIME" | "RATE";
  /** Rate unit: the machine's unit, or "strokes" when counting strokes by time. */
  unit: string;
  period: RatePeriod;
}

export function speedDisplay(
  profile: Pick<ProfileSpec, "cycleMode" | "quantityUnit" | "countedAs" | "standardRatePeriod">,
): SpeedDisplay {
  if (!usesRate(profile.cycleMode)) return { shape: "CYCLE_TIME", unit: "s", period: "SECOND" };
  const counted = effectiveCountedAs(profile.cycleMode, profile.countedAs);
  return {
    shape: "RATE",
    unit: profile.cycleMode === "QUANTITY_PER_INTERVAL" && counted === "CYCLES" ? "strokes" : profile.quantityUnit,
    period: profile.standardRatePeriod,
  };
}

/**
 * A job's planning speed with no station: the job's speed, else the profile's
 * usual speed. Returns output per hour (in the machine's unit for count by
 * amount/time, in parts for count by cycle), or null when there is no speed.
 * `partsPerCount` is the sum of the job's active product quantities.
 */
export function planningRate(
  profile: ProfileSpec,
  job: Speed,
  partsPerCount: number,
): {
  secondsPerCount: number | null;
  countsPerHour: number | null;
  outputPerHour: number | null;
  source: "JOB" | "PROFILE" | null;
} {
  const jobHasSpeed = usesRate(profile.cycleMode)
    ? positive(job.standardRate) != null
    : positive(job.standardCycle) != null;
  const profileHasSpeed = usesRate(profile.cycleMode)
    ? positive(profile.standardRate) != null
    : positive(profile.standardCycle) != null;
  const source = jobHasSpeed ? "JOB" : profileHasSpeed ? "PROFILE" : null;
  if (source == null) return { secondsPerCount: null, countsPerHour: null, outputPerHour: null, source };
  const speed = source === "JOB" ? job : profile;

  const fields = stationFieldsFromProfile("", profile, null);
  const std = resolveStandards({
    cycleMode: profile.cycleMode,
    stationStandardQuantity: fields.standardQuantity,
    stationQuantityUnit: profile.quantityUnit,
    stationStandardCycle: fields.standardCycle,
    stationStandardRate: null,
    stationStandardRateUnit: "",
    stationStandardRatePeriod: "MINUTE",
    jobStandardCycle: usesRate(profile.cycleMode) ? null : speed.standardCycle,
    jobStandardRate: usesRate(profile.cycleMode) ? speed.standardRate : null,
    jobStandardRateUnit: speed.standardRateUnit,
    jobStandardRatePeriod: speed.standardRatePeriod,
  });

  const parts = partsPerCount > 0 ? partsPerCount : 1;
  if (profile.cycleMode === "DISCRETE") {
    const sec = std.standardCycleSeconds;
    if (sec == null) return { secondsPerCount: null, countsPerHour: null, outputPerHour: null, source };
    return { secondsPerCount: sec, countsPerHour: 3600 / sec, outputPerHour: (3600 / sec) * parts, source };
  }
  // Rate kinds: one "count" is one unit of the machine's unit (or one stroke).
  const perUnit = std.secondsPerUnit;
  if (perUnit == null) return { secondsPerCount: null, countsPerHour: null, outputPerHour: null, source };
  // Items per count follow the same rule as recorded cycles: count × product quantity.
  const countsPerHour = 3600 / perUnit;
  return { secondsPerCount: perUnit, countsPerHour, outputPerHour: countsPerHour * parts, source };
}

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

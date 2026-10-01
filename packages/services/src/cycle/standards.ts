// Effective-standard resolution for the three cycle modes — the ONE place the
// standardCycle the system runs off is derived from mode + station + job
// config. Pure, no DB. Mode semantics: see CycleMode in station/station-version.prisma.

import { secondsPerUnitIn, type RatePeriod } from "../lib/units/quantity.js";

export type CycleModeValue = "DISCRETE" | "QUANTITY_PER_CYCLE" | "QUANTITY_PER_INTERVAL";

/** Raw config off the current station/job versions; null/undefined are normalized here.
 *  The machine owns how its signal counts — the amount per signal and the report
 *  interval come from the station only (ADR-0017). The job owns its speed: its
 *  rate or standardCycle beats the station's. */
export interface StandardsConfig {
  cycleMode: CycleModeValue | string | null | undefined;
  /** StationVersion.standardQuantity — standard quantity per cycle event. */
  stationStandardQuantity: number | null;
  /** StationVersion.quantityUnit — the station's canonical unit. */
  stationQuantityUnit: string | null | undefined;
  /** StationVersion.standardCycle — the report interval for QUANTITY_PER_INTERVAL,
   *  else the station's own cycle time. */
  stationStandardCycle: number | null;
  stationStandardRate: number | null;
  stationStandardRateUnit: string | null | undefined;
  stationStandardRatePeriod: RatePeriod | string | null | undefined;
  /** JobVersion.standardCycle — the job's cycle time (seconds per signal). Never
   *  the report interval. */
  jobStandardCycle: number | null;
  jobStandardRate: number | null;
  jobStandardRateUnit: string | null | undefined;
  jobStandardRatePeriod: RatePeriod | string | null | undefined;
}

export interface ResolvedStandards {
  /** Effective standard cycle (s) — what StationJobLog snapshots and detection timers run off. */
  standardCycleSeconds: number | null;
  /** Expected quantity per cycle (pulse size, or rate × interval); null for DISCRETE. */
  standardQuantity: number | null;
  /** Station's canonical unit — stamped on cycles and inventory. */
  quantityUnit: string;
  /** Seconds to produce one unit, in station units; null without a usable rate. */
  secondsPerUnit: number | null;
  mode: CycleModeValue;
}

export function resolveStandards(cfg: StandardsConfig): ResolvedStandards {
  const mode = (cfg.cycleMode ?? "DISCRETE") as CycleModeValue;
  const quantityUnit = cfg.stationQuantityUnit ?? "";
  // Job rate overrides the station default rate; each converts from its own unit/period.
  const perUnit =
    ratePerUnit(cfg.jobStandardRate, cfg.jobStandardRateUnit, cfg.jobStandardRatePeriod, quantityUnit) ??
    ratePerUnit(cfg.stationStandardRate, cfg.stationStandardRateUnit, cfg.stationStandardRatePeriod, quantityUnit);
  // Amount per signal (count by amount), or expected amount per report (count
  // by time, used only without a rate). Station only.
  const configuredQuantity = positive(cfg.stationStandardQuantity);

  if (mode === "QUANTITY_PER_CYCLE") {
    // No usable rate: fall back to a directly-entered job standardCycle.
    const standardCycleSeconds =
      configuredQuantity != null && perUnit != null ? configuredQuantity * perUnit : positive(cfg.jobStandardCycle);
    return { standardCycleSeconds, standardQuantity: configuredQuantity, quantityUnit, secondsPerUnit: perUnit, mode };
  }

  if (mode === "QUANTITY_PER_INTERVAL") {
    // The report interval is set by the machine, so it comes from the station.
    const intervalSeconds = positive(cfg.stationStandardCycle);
    // Rate wins; else the station's expected amount per report.
    const standardQuantity =
      intervalSeconds != null && perUnit != null ? intervalSeconds / perUnit : configuredQuantity;
    return {
      standardCycleSeconds: intervalSeconds,
      standardQuantity,
      quantityUnit,
      // Derive time-per-unit from the config when no rate was entered, so
      // earned time and quantity-slow still work.
      secondsPerUnit:
        perUnit ?? (intervalSeconds != null && standardQuantity != null ? intervalSeconds / standardQuantity : null),
      mode,
    };
  }

  // DISCRETE — the job's entered standardCycle; station standardCycle is the
  // default when the job has none (job beats station, like every input).
  return {
    standardCycleSeconds: positive(cfg.jobStandardCycle) ?? positive(cfg.stationStandardCycle),
    standardQuantity: null,
    quantityUnit,
    secondsPerUnit: null,
    mode,
  };
}

function ratePerUnit(
  rate: number | null,
  unit: string | null | undefined,
  period: RatePeriod | string | null | undefined,
  targetUnit: string,
): number | null {
  if (positive(rate) == null) return null;
  return secondsPerUnitIn(rate as number, unit ?? "", (period ?? "MINUTE") as RatePeriod, targetUnit);
}

/** Per-cycle stamps; field names match the Cycle columns so callers can spread. */
export interface CycleStamp {
  /** Measured quantity, else configured pulse size, else null (DISCRETE). */
  quantity: number | null;
  quantityUnit: string;
  /** Earned standard (s): quantity × secondsPerUnit where a rate exists, else the flat standard. */
  standardCycle: number | null;
  standardQuantity: number | null;
}

export function resolveCycleActuals(std: ResolvedStandards, measuredQuantity: number | null | undefined): CycleStamp {
  const measured = positive(measuredQuantity ?? null);
  const base = { quantityUnit: std.quantityUnit, standardQuantity: std.standardQuantity };

  if (std.mode === "QUANTITY_PER_CYCLE") {
    const quantity = measured ?? std.standardQuantity;
    const standardCycle =
      quantity != null && std.secondsPerUnit != null ? quantity * std.secondsPerUnit : std.standardCycleSeconds;
    return { ...base, quantity, standardCycle };
  }

  if (std.mode === "QUANTITY_PER_INTERVAL") {
    // An interval that reported no quantity earned nothing — no assumption.
    const standardCycle = measured != null && std.secondsPerUnit != null ? measured * std.secondsPerUnit : null;
    return { ...base, quantity: measured, standardCycle };
  }

  return { ...base, quantity: measured, standardCycle: std.standardCycleSeconds };
}

/** Interval-mode slow = quantity shortfall (a slow line still emits on the clock). */
export function quantityWasSlow(std: ResolvedStandards, quantity: number | null, slowFraction: number | null): boolean {
  if (std.mode !== "QUANTITY_PER_INTERVAL") return false;
  if (quantity == null || std.standardQuantity == null) return false;
  if (slowFraction == null || slowFraction <= 0) return false;
  return quantity * (1 + slowFraction) < std.standardQuantity;
}

/** Interval-mode fast = quantity surplus: the inverse of {@link quantityWasSlow}. */
export function quantityWasFast(std: ResolvedStandards, quantity: number | null, fastFraction: number | null): boolean {
  if (std.mode !== "QUANTITY_PER_INTERVAL") return false;
  if (quantity == null || std.standardQuantity == null) return false;
  if (fastFraction == null || fastFraction <= 0) return false;
  return quantity * (1 - fastFraction) > std.standardQuantity;
}

/** How a cycle ran against its standard; null = not judged. Mirrors the CyclePace enum. */
export type CyclePaceValue = "NORMAL" | "SLOW" | "FAST";

/**
 * What decides one cycle's pace, worked out once before the transaction.
 * The thresholds are seconds of cycle time; the quantity flags are the
 * interval-mode outcome, already decided because the quantity is known.
 */
export interface PaceRule {
  /** False = nothing to judge against (no standard): the pace stays null. */
  judged: boolean;
  /** Longer than this is slow; undefined = slow detection is off. */
  slowThresholdSeconds: number | undefined;
  /** Shorter than this is fast; undefined = fast detection is off. */
  fastThresholdSeconds: number | undefined;
  slowByQuantity: boolean;
  fastByQuantity: boolean;
}

/** A pace rule that judges nothing — replays of cycles with no usable standard. */
export const NO_PACE_RULE: PaceRule = {
  judged: false,
  slowThresholdSeconds: undefined,
  fastThresholdSeconds: undefined,
  slowByQuantity: false,
  fastByQuantity: false,
};

/**
 * The pace rule for one cycle. `slowFraction`/`fastFraction` are the EFFECTIVE
 * detects (the station's own, else its workcenter's); null or 0 = off.
 * Fast is slow's inverse: slow is longer than standard × (1 + slow), fast is
 * shorter than standard × (1 − fast). A fast fraction of 1 or more could never
 * be met (a cycle cannot take no time), so it is off.
 */
export function resolvePaceRule(
  std: ResolvedStandards,
  quantity: number | null,
  slowFraction: number | null,
  fastFraction: number | null,
): PaceRule {
  const standard = positive(std.standardCycleSeconds);
  const slow = positive(slowFraction);
  const fast = positive(fastFraction);
  return {
    judged: standard != null,
    slowThresholdSeconds: standard != null && slow != null ? standard * (1 + slow) : undefined,
    fastThresholdSeconds: standard != null && fast != null && fast < 1 ? standard * (1 - fast) : undefined,
    slowByQuantity: quantityWasSlow(std, quantity, slowFraction),
    fastByQuantity: quantityWasFast(std, quantity, fastFraction),
  };
}

/**
 * One cycle's pace. `durationSeconds` null or 0 is a cycle with no measured
 * length (the station's first): only an interval-mode quantity can judge it.
 * Slow wins a tie it cannot really have (a late AND oversized interval).
 * Keep in step with {@link paceSql} in cycle.ts, which decides the same thing
 * inside the insert.
 */
export function judgePace(rule: PaceRule, durationSeconds: number | null): CyclePaceValue | null {
  if (rule.slowByQuantity) return "SLOW";
  if (rule.fastByQuantity) return "FAST";
  if (!rule.judged || durationSeconds == null || durationSeconds <= 0) return null;
  if (rule.slowThresholdSeconds != null && durationSeconds > rule.slowThresholdSeconds) return "SLOW";
  if (rule.fastThresholdSeconds != null && durationSeconds < rule.fastThresholdSeconds) return "FAST";
  return "NORMAL";
}

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

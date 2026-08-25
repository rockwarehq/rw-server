// Effective-standard resolution for the three cycle modes — the ONE place the
// standardCycle the system runs off is derived from mode + station + job
// config. Pure, no DB. Mode semantics: see CycleMode in workcenter.prisma.

import { secondsPerUnitIn, type RatePeriod } from "../lib/units/quantity.js";

export type CycleModeValue = "DISCRETE" | "QUANTITY_PER_CYCLE" | "QUANTITY_PER_INTERVAL";

/** Raw config off the current station/job versions; null/undefined are normalized here.
 *  Every input is a station default with a job override: rate, quantity, standardCycle. */
export interface StandardsConfig {
  cycleMode: CycleModeValue | string | null | undefined;
  /** StationVersion.standardQuantity — standard quantity per cycle event. */
  stationStandardQuantity: number | null;
  /** StationVersion.quantityUnit — the station's canonical unit. */
  stationQuantityUnit: string | null | undefined;
  /** StationVersion.standardCycle — the interval length for QUANTITY_PER_INTERVAL. */
  stationStandardCycle: number | null;
  stationStandardRate: number | null;
  stationStandardRateUnit: string | null | undefined;
  stationStandardRatePeriod: RatePeriod | string | null | undefined;
  /** JobVersion.standardCycle — entered directly (DISCRETE). */
  jobStandardCycle: number | null;
  jobStandardRate: number | null;
  jobStandardRateUnit: string | null | undefined;
  jobStandardRatePeriod: RatePeriod | string | null | undefined;
  /** JobVersion.standardQuantity — per-job override; null = inherit. */
  jobStandardQuantity: number | null;
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
  const configuredQuantity = positive(cfg.jobStandardQuantity) ?? positive(cfg.stationStandardQuantity);

  if (mode === "QUANTITY_PER_CYCLE") {
    // No usable rate: fall back to a directly-entered job standardCycle.
    const standardCycleSeconds =
      configuredQuantity != null && perUnit != null ? configuredQuantity * perUnit : positive(cfg.jobStandardCycle);
    return { standardCycleSeconds, standardQuantity: configuredQuantity, quantityUnit, secondsPerUnit: perUnit, mode };
  }

  if (mode === "QUANTITY_PER_INTERVAL") {
    // Tick length: job override, else station — only valid when the machine
    // actually reports at the overridden cadence for that job.
    const intervalSeconds = positive(cfg.jobStandardCycle) ?? positive(cfg.stationStandardCycle);
    // Rate wins; else the configured per-tick quantity (job override, else station).
    const standardQuantity =
      intervalSeconds != null && perUnit != null ? intervalSeconds / perUnit : configuredQuantity;
    return {
      standardCycleSeconds: intervalSeconds,
      standardQuantity,
      quantityUnit,
      // Derive time-per-unit from the config when no rate was entered, so
      // earned time and quantity-slow still work.
      secondsPerUnit:
        perUnit ??
        (intervalSeconds != null && standardQuantity != null ? intervalSeconds / standardQuantity : null),
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
export function quantityWasSlow(
  std: ResolvedStandards,
  quantity: number | null,
  slowFraction: number | null,
): boolean {
  if (std.mode !== "QUANTITY_PER_INTERVAL") return false;
  if (quantity == null || std.standardQuantity == null) return false;
  if (slowFraction == null || slowFraction <= 0) return false;
  return quantity * (1 + slowFraction) < std.standardQuantity;
}

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

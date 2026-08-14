import { describe, expect, it } from "vitest";

import {
  ADDITIVE_KPI_KEYS,
  type BucketKPIs,
  computeAvailability,
  computeOee,
  computePerformance,
  computeQuality,
  sumKPIs,
  ZERO_KPIS,
} from "../index.js";

// ── Frozen reference implementations ─────────────────────────────
// Verbatim copies of the pre-catalog compute functions. The catalog-backed
// wrappers must be observably identical to these for ANY input.

function oldComputeAvailability(kpis: BucketKPIs): number | null {
  if (kpis.elapsedPlannedProductionSeconds <= 0) return null;
  return kpis.runSeconds / kpis.elapsedPlannedProductionSeconds;
}

function oldComputePerformance(kpis: BucketKPIs): number | null {
  if (kpis.elapsedPlannedProductionSeconds <= 0) return null;
  if (kpis.runSeconds <= 0) return 0;
  return kpis.idealCycleSeconds / kpis.runSeconds;
}

function oldComputeQuality(kpis: BucketKPIs): number | null {
  if (kpis.elapsedPlannedProductionSeconds <= 0) return null;
  if (kpis.totalItems <= 0) return 0;
  return (kpis.totalItems - kpis.badItems) / kpis.totalItems;
}

function oldComputeOee(kpis: BucketKPIs): number | null {
  if (kpis.elapsedPlannedProductionSeconds <= 0) return null;
  if (kpis.totalItems <= 0) return 0;
  return (
    (kpis.idealCycleSeconds * (kpis.totalItems - kpis.badItems)) /
    (kpis.elapsedPlannedProductionSeconds * kpis.totalItems)
  );
}

const mk = (partial: Partial<BucketKPIs>): BucketKPIs => ({ ...ZERO_KPIS, ...partial });

const CASES: Array<[name: string, kpis: BucketKPIs]> = [
  ["all zeros", mk({})],
  [
    "no production window but items produced",
    mk({ elapsedPlannedProductionSeconds: 0, totalItems: 10, badItems: 2, runSeconds: 100, idealCycleSeconds: 80 }),
  ],
  [
    "window > 0 with runSeconds = 0",
    mk({ elapsedPlannedProductionSeconds: 3600, runSeconds: 0, idealCycleSeconds: 0, totalItems: 5, badItems: 1 }),
  ],
  [
    "window > 0 with totalItems = 0",
    mk({ elapsedPlannedProductionSeconds: 3600, runSeconds: 1800, idealCycleSeconds: 1700, totalItems: 0 }),
  ],
  [
    "negative badItems",
    mk({ elapsedPlannedProductionSeconds: 3600, runSeconds: 100, idealCycleSeconds: 90, totalItems: 10, badItems: -5 }),
  ],
  [
    "badItems > totalItems",
    mk({
      elapsedPlannedProductionSeconds: 3600,
      runSeconds: 1000,
      idealCycleSeconds: 900,
      totalItems: 10,
      badItems: 15,
    }),
  ],
  [
    "negative window",
    mk({ elapsedPlannedProductionSeconds: -100, runSeconds: 50, idealCycleSeconds: 40, totalItems: 5, badItems: 1 }),
  ],
  [
    "negative runSeconds with window > 0",
    mk({ elapsedPlannedProductionSeconds: 3600, runSeconds: -10, idealCycleSeconds: 40, totalItems: 5, badItems: 1 }),
  ],
  [
    "large values",
    mk({
      elapsedPlannedProductionSeconds: 3.6e12,
      runSeconds: 2.9e12,
      idealCycleSeconds: 2.7e12,
      totalItems: 1e9,
      badItems: 3e7,
    }),
  ],
  [
    "typical shift",
    mk({
      elapsedPlannedProductionSeconds: 28800,
      runSeconds: 25000,
      idealCycleSeconds: 24000,
      totalItems: 1000,
      badItems: 50,
    }),
  ],
];

describe("catalog-backed compute functions match the frozen implementations", () => {
  it.each(CASES)("%s", (_name, kpis) => {
    expect(computeAvailability(kpis)).toBe(oldComputeAvailability(kpis));
    expect(computePerformance(kpis)).toBe(oldComputePerformance(kpis));
    expect(computeQuality(kpis)).toBe(oldComputeQuality(kpis));
    expect(computeOee(kpis)).toBe(oldComputeOee(kpis));
  });
});

describe("ADDITIVE_KPI_KEYS", () => {
  it("is exactly the published list, in order", () => {
    expect([...ADDITIVE_KPI_KEYS]).toEqual([
      "totalCycles",
      "badCycles",
      "totalItems",
      "badItems",
      "expectedCycles",
      "expectedItems",
      "runSeconds",
      "downSeconds",
      "plannedDownSeconds",
      "unplannedDownSeconds",
      "idealCycleSeconds",
      "totalCycleSeconds",
      "elapsedExpectedCycles",
      "elapsedExpectedItems",
      "elapsedPlannedProductionSeconds",
    ]);
  });
});

describe("ratio-of-sums vs average-of-ratios", () => {
  // Documents the invariant behind sum-then-compute: ratios are intensive
  // and must be recomputed over summed components, never averaged.
  it("differ on unequal windows", () => {
    const a = mk({ elapsedPlannedProductionSeconds: 3600, runSeconds: 3600 }); // availability 1.0
    const b = mk({ elapsedPlannedProductionSeconds: 7200, runSeconds: 1800 }); // availability 0.25
    const ratioOfSums = computeAvailability(sumKPIs([a, b]));
    const averageOfRatios = ((computeAvailability(a) as number) + (computeAvailability(b) as number)) / 2;
    expect(ratioOfSums).toBe(5400 / 10800);
    expect(averageOfRatios).toBe(0.625);
    expect(ratioOfSums).not.toBe(averageOfRatios);
  });
});

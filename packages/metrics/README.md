# @rockwarehq/metrics

Shared KPI types, constants, and OEE calculation functions for Rockware.

## Why this exists

OEE ratios (availability, performance, quality, oee) are computed as **PostgreSQL generated columns** on `MetricBucket` and `MetricBucketLog`. This works for individual rows, but when code needs to aggregate across rows (e.g., summing shifts into a daily total, or computing a totals row across stations), it must recompute the ratios from summed raw values.

This package provides the calculation functions as pure TypeScript, mirroring the SQL formulas exactly. Both `rw-server` and `rw-workspace` import from here — one place to update if the formulas change.

## Usage

```ts
import {
  type BucketKPIs,
  sumKPIs,
  computeAllKpis,
  computeOee,
  ZERO_KPIS,
  ADDITIVE_KPI_KEYS,
} from "@rockwarehq/metrics";

// Sum multiple buckets (e.g., across shifts)
const daily = sumKPIs([shift1, shift2, shift3]);

// Compute OEE ratios from the summed raw values
const { availability, performance, quality, oee } = computeAllKpis(daily);
```

## Keeping in sync with SQL

The OEE functions mirror these PostgreSQL generated columns:

| Function | SQL source |
|----------|-----------|
| `computeAvailability` | `runSeconds / elapsedPlannedProductionSeconds` |
| `computePerformance` | `idealCycleSeconds / runSeconds` |
| `computeQuality` | `(totalItems - badItems) / totalItems` |
| `computeOee` | `(idealCycleSeconds * (totalItems - badItems)) / (elapsedPlannedProductionSeconds * totalItems)` |

NULL semantics match the SQL CASE expressions — see migration `20260325000000_oee_zero_not_null` for the full definitions.

**If you change the SQL generated columns, update the functions in `src/index.ts` to match.**

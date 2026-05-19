-- Rename "Parts" columns to "Items" for naming consistency
-- (Product = what can be made, Item = what was made)
ALTER TABLE "MetricBucket" RENAME COLUMN "totalParts" TO "totalItems";
ALTER TABLE "MetricBucket" RENAME COLUMN "goodParts" TO "goodItems";
ALTER TABLE "MetricBucket" RENAME COLUMN "badParts" TO "badItems";

-- Add OEE building-block columns
ALTER TABLE "MetricBucket" ADD COLUMN "currentStandardCycle" DECIMAL(10,2);
ALTER TABLE "MetricBucket" ADD COLUMN "expectedItems" INT NOT NULL DEFAULT 0;
ALTER TABLE "MetricBucket" ADD COLUMN "elapsedExpectedCycles" INT NOT NULL DEFAULT 0;
ALTER TABLE "MetricBucket" ADD COLUMN "elapsedExpectedItems" INT NOT NULL DEFAULT 0;
ALTER TABLE "MetricBucket" ADD COLUMN "elapsedPlannedProductionSeconds" INT NOT NULL DEFAULT 0;

-- Add computed OEE ratio columns (PostgreSQL GENERATED ALWAYS AS ... STORED)
-- These auto-update whenever the underlying KPI columns are updated.
-- NULL when the denominator is zero (no meaningful value).

-- Availability = runSeconds / elapsedPlannedProductionSeconds
ALTER TABLE "MetricBucket" ADD COLUMN "availability" DECIMAL(7,6)
  GENERATED ALWAYS AS (
    CASE WHEN "elapsedPlannedProductionSeconds" > 0
         THEN "runSeconds"::numeric / "elapsedPlannedProductionSeconds"::numeric
         ELSE NULL
    END
  ) STORED;

-- Performance = idealCycleSeconds / runSeconds
ALTER TABLE "MetricBucket" ADD COLUMN "performance" DECIMAL(7,6)
  GENERATED ALWAYS AS (
    CASE WHEN "runSeconds" > 0
         THEN "idealCycleSeconds"::numeric / "runSeconds"::numeric
         ELSE NULL
    END
  ) STORED;

-- Quality = goodCycles / totalCycles
ALTER TABLE "MetricBucket" ADD COLUMN "quality" DECIMAL(7,6)
  GENERATED ALWAYS AS (
    CASE WHEN "totalCycles" > 0
         THEN "goodCycles"::numeric / "totalCycles"::numeric
         ELSE NULL
    END
  ) STORED;

-- OEE = Availability * Performance * Quality
-- Simplified: (idealCycleSeconds * goodCycles) / (elapsedPlannedProductionSeconds * totalCycles)
-- because runSeconds cancels out in (run/elapsed) * (ideal/run) * (good/total)
ALTER TABLE "MetricBucket" ADD COLUMN "oee" DECIMAL(7,6)
  GENERATED ALWAYS AS (
    CASE WHEN "elapsedPlannedProductionSeconds" > 0
              AND "totalCycles" > 0
         THEN ("idealCycleSeconds"::numeric * "goodCycles"::numeric)
              / ("elapsedPlannedProductionSeconds"::numeric * "totalCycles"::numeric)
         ELSE NULL
    END
  ) STORED;

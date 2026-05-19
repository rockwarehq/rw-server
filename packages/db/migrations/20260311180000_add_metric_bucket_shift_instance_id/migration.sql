-- Add optional shiftInstanceId column to MetricBucket.
-- Informational reference to the ShiftInstance this bucket falls within.
-- No FK constraint — purely for querying/filtering.

ALTER TABLE "MetricBucket" ADD COLUMN "shiftInstanceId" UUID;

-- Index for efficient lookups by shift instance
CREATE INDEX "MetricBucket_shiftInstanceId_idx" ON "MetricBucket"("shiftInstanceId");

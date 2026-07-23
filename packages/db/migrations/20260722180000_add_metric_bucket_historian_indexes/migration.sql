-- Historian delta scans (ADR 0008) fetch metricBucket changes by
-- change-timestamp watermark: `updatedAt` on the live table, `archivedAt`
-- on the archive. Without these each poll is a scan over site history.

-- CreateIndex
CREATE INDEX "MetricBucket_siteId_updatedAt_idx" ON "MetricBucket"("siteId", "updatedAt");

-- CreateIndex
CREATE INDEX "MetricBucketLog_siteId_archivedAt_idx" ON "MetricBucketLog"("siteId", "archivedAt");

-- Historian delta scans (ADR 0008) fetch stationState changes by
-- change-timestamp watermark; without this index each poll is a
-- stationId-only scan over the full state-log history.

-- CreateIndex
CREATE INDEX "StationStateLog_stationId_updatedAt_idx" ON "StationStateLog"("stationId", "updatedAt");

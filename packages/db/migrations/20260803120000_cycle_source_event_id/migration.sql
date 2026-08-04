-- Idempotent cycle recording: each livestore hook event records at most one
-- cycle (redeliveries hit the unique index instead of double-recording).
-- NULLs (manual/API cycles) never conflict.

-- AlterTable
ALTER TABLE "Cycle" ADD COLUMN "sourceEventId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "Cycle_sourceEventId_key" ON "Cycle"("sourceEventId");

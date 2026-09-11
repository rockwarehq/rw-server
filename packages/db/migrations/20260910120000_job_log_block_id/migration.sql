-- StationJobLog.blockId: one value per job assignment, shared by the per-shift
-- pieces a row is cut into. Existing rows are their own block.
ALTER TABLE "StationJobLog" ADD COLUMN "blockId" TEXT;
UPDATE "StationJobLog" SET "blockId" = id::text;
ALTER TABLE "StationJobLog" ALTER COLUMN "blockId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "StationJobLog_blockId_idx" ON "StationJobLog"("blockId");

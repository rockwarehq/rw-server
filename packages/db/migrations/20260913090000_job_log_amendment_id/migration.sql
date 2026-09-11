-- AlterTable
ALTER TABLE "StationJobLog" ADD COLUMN     "amendmentId" UUID;

-- CreateIndex
CREATE INDEX "StationJobLog_amendmentId_idx" ON "StationJobLog"("amendmentId");

-- AddForeignKey
ALTER TABLE "StationJobLog" ADD CONSTRAINT "StationJobLog_amendmentId_fkey" FOREIGN KEY ("amendmentId") REFERENCES "JobHistoryAmendment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

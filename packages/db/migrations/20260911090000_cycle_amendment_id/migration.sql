-- AlterTable
ALTER TABLE "Cycle" ADD COLUMN     "amendmentId" UUID;

-- CreateIndex
CREATE INDEX "Cycle_amendmentId_idx" ON "Cycle"("amendmentId");

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_amendmentId_fkey" FOREIGN KEY ("amendmentId") REFERENCES "JobHistoryAmendment"("id") ON DELETE SET NULL ON UPDATE CASCADE;


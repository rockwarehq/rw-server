-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN     "amendmentId" UUID;

-- CreateIndex
CREATE INDEX "InventoryItem_amendmentId_idx" ON "InventoryItem"("amendmentId");

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_amendmentId_fkey" FOREIGN KEY ("amendmentId") REFERENCES "JobHistoryAmendment"("id") ON DELETE SET NULL ON UPDATE CASCADE;


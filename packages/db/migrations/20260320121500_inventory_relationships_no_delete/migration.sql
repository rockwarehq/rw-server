-- AlterTable
ALTER TABLE "ItemDispositionLog" ADD COLUMN     "itemDispositionId" UUID;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_itemDispositionId_fkey" FOREIGN KEY ("itemDispositionId") REFERENCES "ItemDisposition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

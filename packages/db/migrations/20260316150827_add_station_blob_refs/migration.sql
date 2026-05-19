/*
  Warnings:

  - Added the required column `stationId` to the `ItemDispositionLog` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Cycle" ADD COLUMN     "stationBlobId" UUID;

-- AlterTable
ALTER TABLE "ItemDispositionLog" ADD COLUMN     "stationId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "StationStateLog" ADD COLUMN     "stationBlobId" UUID;

-- CreateIndex
CREATE INDEX "ItemDispositionLog_stationId_createdAt_idx" ON "ItemDispositionLog"("stationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_stationBlobId_fkey" FOREIGN KEY ("stationBlobId") REFERENCES "StationBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_stationBlobId_fkey" FOREIGN KEY ("stationBlobId") REFERENCES "StationBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

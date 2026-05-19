/*
  Warnings:

  - You are about to drop the column `stationStatusReasonId` on the `StationStateLog` table. All the data in the column will be lost.
  - You are about to drop the `StationStatusCategory` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `StationStatusReason` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `_ProcessTypeToStationStatusReason` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `_StationStatusReasonToWorkcenter` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `_StationToStationStatusReason` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "StationStateLog" DROP CONSTRAINT "StationStateLog_stationStatusReasonId_fkey";

-- DropForeignKey
ALTER TABLE "StationStatusReason" DROP CONSTRAINT "StationStatusReason_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "StationStatusReason" DROP CONSTRAINT "StationStatusReason_siteId_fkey";

-- DropForeignKey
ALTER TABLE "_ProcessTypeToStationStatusReason" DROP CONSTRAINT "_ProcessTypeToStationStatusReason_A_fkey";

-- DropForeignKey
ALTER TABLE "_ProcessTypeToStationStatusReason" DROP CONSTRAINT "_ProcessTypeToStationStatusReason_B_fkey";

-- DropForeignKey
ALTER TABLE "_StationStatusReasonToWorkcenter" DROP CONSTRAINT "_StationStatusReasonToWorkcenter_A_fkey";

-- DropForeignKey
ALTER TABLE "_StationStatusReasonToWorkcenter" DROP CONSTRAINT "_StationStatusReasonToWorkcenter_B_fkey";

-- DropForeignKey
ALTER TABLE "_StationToStationStatusReason" DROP CONSTRAINT "_StationToStationStatusReason_A_fkey";

-- DropForeignKey
ALTER TABLE "_StationToStationStatusReason" DROP CONSTRAINT "_StationToStationStatusReason_B_fkey";

-- DropIndex
DROP INDEX "Station_currentJobId_key";

-- DropIndex
DROP INDEX "StationStateLog_stationStatusReasonId_idx";

-- AlterTable
ALTER TABLE "StationStateLog" DROP COLUMN "stationStatusReasonId",
ADD COLUMN     "statusReasonId" UUID;

-- DropTable
DROP TABLE "StationStatusCategory";

-- DropTable
DROP TABLE "StationStatusReason";

-- DropTable
DROP TABLE "_ProcessTypeToStationStatusReason";

-- DropTable
DROP TABLE "_StationStatusReasonToWorkcenter";

-- DropTable
DROP TABLE "_StationToStationStatusReason";

-- CreateTable
CREATE TABLE "ItemDisposition" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ItemDisposition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemDispositionReason" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "itemDispositionId" UUID,
    "siteId" UUID NOT NULL,
    "processTypeId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ItemDispositionReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemDispositionLog" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "siteId" UUID NOT NULL,
    "cycleId" UUID,
    "shiftInstanceId" UUID,
    "dispositionReasonId" UUID,
    "stationBlobId" UUID,
    "jobProductBlobId" UUID,
    "productBlobId" UUID NOT NULL,
    "toolBlobId" UUID,
    "toolCavityBlobId" UUID,

    CONSTRAINT "ItemDispositionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusReason" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isPlannedDown" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "siteId" UUID NOT NULL,
    "categoryId" UUID,

    CONSTRAINT "StatusReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusCategory" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "siteId" UUID NOT NULL,

    CONSTRAINT "StatusCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ItemDispositionLogToMaterialBlob" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_ItemDispositionLogToMaterialBlob_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_StationToStatusReason" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_StationToStatusReason_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ProcessTypeToStatusReason" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_ProcessTypeToStatusReason_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_StatusReasonToWorkcenter" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_StatusReasonToWorkcenter_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "ItemDisposition_siteId_idx" ON "ItemDisposition"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemDisposition_siteId_name_key" ON "ItemDisposition"("siteId", "name");

-- CreateIndex
CREATE INDEX "ItemDispositionReason_siteId_idx" ON "ItemDispositionReason"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemDispositionReason_siteId_name_key" ON "ItemDispositionReason"("siteId", "name");

-- CreateIndex
CREATE INDEX "StatusReason_siteId_idx" ON "StatusReason"("siteId");

-- CreateIndex
CREATE INDEX "StatusReason_categoryId_idx" ON "StatusReason"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "StatusReason_siteId_name_key" ON "StatusReason"("siteId", "name");

-- CreateIndex
CREATE INDEX "StatusCategory_siteId_idx" ON "StatusCategory"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "StatusCategory_siteId_name_key" ON "StatusCategory"("siteId", "name");

-- CreateIndex
CREATE INDEX "_ItemDispositionLogToMaterialBlob_B_index" ON "_ItemDispositionLogToMaterialBlob"("B");

-- CreateIndex
CREATE INDEX "_StationToStatusReason_B_index" ON "_StationToStatusReason"("B");

-- CreateIndex
CREATE INDEX "_ProcessTypeToStatusReason_B_index" ON "_ProcessTypeToStatusReason"("B");

-- CreateIndex
CREATE INDEX "_StatusReasonToWorkcenter_B_index" ON "_StatusReasonToWorkcenter"("B");

-- CreateIndex
CREATE INDEX "Station_currentJobId_idx" ON "Station"("currentJobId");

-- CreateIndex
CREATE INDEX "StationStateLog_statusReasonId_idx" ON "StationStateLog"("statusReasonId");

-- AddForeignKey
ALTER TABLE "ItemDisposition" ADD CONSTRAINT "ItemDisposition_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionReason" ADD CONSTRAINT "ItemDispositionReason_itemDispositionId_fkey" FOREIGN KEY ("itemDispositionId") REFERENCES "ItemDisposition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionReason" ADD CONSTRAINT "ItemDispositionReason_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionReason" ADD CONSTRAINT "ItemDispositionReason_processTypeId_fkey" FOREIGN KEY ("processTypeId") REFERENCES "ProcessType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_dispositionReasonId_fkey" FOREIGN KEY ("dispositionReasonId") REFERENCES "ItemDispositionReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_stationBlobId_fkey" FOREIGN KEY ("stationBlobId") REFERENCES "StationBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_jobProductBlobId_fkey" FOREIGN KEY ("jobProductBlobId") REFERENCES "JobProductBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_productBlobId_fkey" FOREIGN KEY ("productBlobId") REFERENCES "ProductBlob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_toolBlobId_fkey" FOREIGN KEY ("toolBlobId") REFERENCES "ToolBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_toolCavityBlobId_fkey" FOREIGN KEY ("toolCavityBlobId") REFERENCES "ToolCavityBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_statusReasonId_fkey" FOREIGN KEY ("statusReasonId") REFERENCES "StatusReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusReason" ADD CONSTRAINT "StatusReason_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusReason" ADD CONSTRAINT "StatusReason_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "StatusCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusCategory" ADD CONSTRAINT "StatusCategory_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ItemDispositionLogToMaterialBlob" ADD CONSTRAINT "_ItemDispositionLogToMaterialBlob_A_fkey" FOREIGN KEY ("A") REFERENCES "ItemDispositionLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ItemDispositionLogToMaterialBlob" ADD CONSTRAINT "_ItemDispositionLogToMaterialBlob_B_fkey" FOREIGN KEY ("B") REFERENCES "MaterialBlob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StationToStatusReason" ADD CONSTRAINT "_StationToStatusReason_A_fkey" FOREIGN KEY ("A") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StationToStatusReason" ADD CONSTRAINT "_StationToStatusReason_B_fkey" FOREIGN KEY ("B") REFERENCES "StatusReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProcessTypeToStatusReason" ADD CONSTRAINT "_ProcessTypeToStatusReason_A_fkey" FOREIGN KEY ("A") REFERENCES "ProcessType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProcessTypeToStatusReason" ADD CONSTRAINT "_ProcessTypeToStatusReason_B_fkey" FOREIGN KEY ("B") REFERENCES "StatusReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StatusReasonToWorkcenter" ADD CONSTRAINT "_StatusReasonToWorkcenter_A_fkey" FOREIGN KEY ("A") REFERENCES "StatusReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StatusReasonToWorkcenter" ADD CONSTRAINT "_StatusReasonToWorkcenter_B_fkey" FOREIGN KEY ("B") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

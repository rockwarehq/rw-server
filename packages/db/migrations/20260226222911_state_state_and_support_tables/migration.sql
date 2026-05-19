/*
  Warnings:

  - The values [RUNNING,OVERCYCLE,PLANNED_DOWN,UNPLANNED_DOWN,CHANGEOVER] on the enum `StationStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `jobItemBlobId` on the `InventoryItem` table. All the data in the column will be lost.
  - You are about to drop the column `laborCost` on the `ProductBlob` table. All the data in the column will be lost.
  - You are about to drop the column `deletedAt` on the `ProductMaterial` table. All the data in the column will be lost.
  - You are about to drop the `JobItem` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobItemBlob` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `StationStatusLog` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `StatusReason` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[currentJobId]` on the table `Station` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[currentBlobId]` on the table `Station` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[toolLocationId]` on the table `Tool` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "StandardCycleUnit" AS ENUM ('SECONDS');

-- CreateEnum
CREATE TYPE "ToolClassificationType" AS ENUM ('MACHINE_SPEC', 'GROUP');

-- CreateEnum
CREATE TYPE "StationState" AS ENUM ('UP', 'DOWN');

-- CreateEnum
CREATE TYPE "DowntimeDetectUnit" AS ENUM ('SECONDS');

-- CreateEnum
CREATE TYPE "SlowDetectUnit" AS ENUM ('PERCENTAGE');

-- CreateEnum
CREATE TYPE "StationClassificationType" AS ENUM ('MACHINE_SPEC', 'GROUP');

-- DropForeignKey
ALTER TABLE "InventoryItem" DROP CONSTRAINT "InventoryItem_jobItemBlobId_fkey";

-- DropForeignKey
ALTER TABLE "JobItem" DROP CONSTRAINT "JobItem_currentBlobId_fkey";

-- DropForeignKey
ALTER TABLE "JobItem" DROP CONSTRAINT "JobItem_jobId_fkey";

-- DropForeignKey
ALTER TABLE "JobItem" DROP CONSTRAINT "JobItem_productId_fkey";

-- DropForeignKey
ALTER TABLE "JobItem" DROP CONSTRAINT "JobItem_toolCavityId_fkey";

-- DropForeignKey
ALTER TABLE "JobItem" DROP CONSTRAINT "JobItem_toolId_fkey";

-- DropForeignKey
ALTER TABLE "JobItemBlob" DROP CONSTRAINT "JobItemBlob_jobItemId_fkey";

-- DropForeignKey
ALTER TABLE "StationStatusLog" DROP CONSTRAINT "StationStatusLog_stationId_fkey";

-- DropForeignKey
ALTER TABLE "StatusReason" DROP CONSTRAINT "StatusReason_workspaceId_fkey";

-- DropIndex
DROP INDEX "InventoryItem_jobItemBlobId_idx";

-- AlterTable
ALTER TABLE "InventoryItem" DROP COLUMN "jobItemBlobId",
ADD COLUMN     "jobProductBlobId" UUID;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "processTypeId" UUID;

-- AlterTable
ALTER TABLE "JobBlob" ADD COLUMN     "standardCycleUnit" "StandardCycleUnit" NOT NULL DEFAULT 'SECONDS';

-- AlterTable
ALTER TABLE "Material" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MaterialBlob" ADD COLUMN     "classification" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ProductBlob" DROP COLUMN "laborCost";

-- AlterTable
ALTER TABLE "ProductMaterial" DROP COLUMN "deletedAt",
ADD COLUMN     "itemCost" DECIMAL(10,2),
ADD COLUMN     "weight" DECIMAL(10,2),
ADD COLUMN     "weightUnits" "WeightUnit";

-- AlterTable
ALTER TABLE "Station" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "currentBlobId" UUID,
ADD COLUMN     "currentJobId" UUID,
ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Tool" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "lifeCount" INTEGER DEFAULT 0,
ADD COLUMN     "pmCount" INTEGER DEFAULT 0,
ADD COLUMN     "toolLocationId" UUID,
ADD COLUMN     "toolStatusId" UUID;

-- AlterTable
ALTER TABLE "ToolBlob" DROP COLUMN "cavityCount",
ADD COLUMN     "pmLimit" INTEGER,
ADD COLUMN     "pmWarn" INTEGER;

-- DropTable
DROP TABLE "JobItem";

-- DropTable
DROP TABLE "JobItemBlob";

-- DropTable
DROP TABLE "StationStatusLog";

-- DropTable
DROP TABLE "StatusReason";

-- CreateTable
CREATE TABLE "JobProduct" (
    "id" UUID NOT NULL,
    "currentBlobId" UUID,
    "jobId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "toolId" UUID,
    "toolCavityId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "JobProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobProductBlob" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "jobProductId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobProductBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolStatus" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "siteId" UUID NOT NULL,

    CONSTRAINT "ToolStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolClassification" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ToolClassificationType" NOT NULL,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "siteId" UUID NOT NULL,

    CONSTRAINT "ToolClassification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolLocation" (
    "id" UUID NOT NULL,
    "location" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "siteId" UUID NOT NULL,

    CONSTRAINT "ToolLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationStateLog" (
    "id" UUID NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "state" "StationState" NOT NULL,
    "blockId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "stationId" UUID NOT NULL,
    "status" "StationStatus",
    "stationStatusReasonId" UUID,

    CONSTRAINT "StationStateLog_pkey" PRIMARY KEY ("id")
);

-- AlterEnum
BEGIN;
CREATE TYPE "StationStatus_new" AS ENUM ('FAST', 'SLOW', 'UP', 'DOWN');
ALTER TABLE "StationStateLog" ALTER COLUMN "status" TYPE "StationStatus_new" USING ("status"::text::"StationStatus_new");
ALTER TYPE "StationStatus" RENAME TO "StationStatus_old";
ALTER TYPE "StationStatus_new" RENAME TO "StationStatus";
DROP TYPE "public"."StationStatus_old";
COMMIT;

-- CreateTable
CREATE TABLE "StationStatusReason" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isPlannedDown" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "siteId" UUID NOT NULL,
    "categoryId" UUID,

    CONSTRAINT "StationStatusReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationStatusCategory" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "StationStatusCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationBlob" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "standardCycle" DECIMAL(10,2),
    "inLineCalculations" BOOLEAN NOT NULL DEFAULT false,
    "inStationCalculations" BOOLEAN NOT NULL DEFAULT false,
    "downtimeDetect" DECIMAL(10,2),
    "downtimeDetectUnit" "DowntimeDetectUnit" NOT NULL DEFAULT 'SECONDS',
    "slowDetect" DECIMAL(10,2),
    "slowDetectUnit" "SlowDetectUnit" NOT NULL DEFAULT 'PERCENTAGE',
    "processTypeId" UUID,
    "stationId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationClassification" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "StationClassificationType" NOT NULL,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "siteId" UUID NOT NULL,

    CONSTRAINT "StationClassification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationJob" (
    "id" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessType" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "siteId" UUID NOT NULL,

    CONSTRAINT "ProcessType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ToolToToolClassification" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_ToolToToolClassification_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_StationToStationClassification" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_StationToStationClassification_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_StationToStationStatusReason" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_StationToStationStatusReason_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_StationStatusReasonToWorkcenter" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_StationStatusReasonToWorkcenter_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ProcessTypeToStationStatusReason" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_ProcessTypeToStationStatusReason_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobProduct_currentBlobId_key" ON "JobProduct"("currentBlobId");

-- CreateIndex
CREATE INDEX "JobProduct_jobId_idx" ON "JobProduct"("jobId");

-- CreateIndex
CREATE INDEX "JobProduct_productId_idx" ON "JobProduct"("productId");

-- CreateIndex
CREATE INDEX "JobProduct_toolId_idx" ON "JobProduct"("toolId");

-- CreateIndex
CREATE INDEX "JobProduct_toolCavityId_idx" ON "JobProduct"("toolCavityId");

-- CreateIndex
CREATE INDEX "JobProductBlob_jobProductId_idx" ON "JobProductBlob"("jobProductId");

-- CreateIndex
CREATE UNIQUE INDEX "JobProductBlob_jobProductId_version_key" ON "JobProductBlob"("jobProductId", "version");

-- CreateIndex
CREATE INDEX "ToolStatus_siteId_idx" ON "ToolStatus"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolStatus_siteId_name_key" ON "ToolStatus"("siteId", "name");

-- CreateIndex
CREATE INDEX "ToolClassification_siteId_idx" ON "ToolClassification"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolClassification_siteId_name_key" ON "ToolClassification"("siteId", "name");

-- CreateIndex
CREATE INDEX "ToolLocation_siteId_idx" ON "ToolLocation"("siteId");

-- CreateIndex
CREATE INDEX "StationStateLog_stationId_idx" ON "StationStateLog"("stationId");

-- CreateIndex
CREATE INDEX "StationStateLog_stationId_endTime_idx" ON "StationStateLog"("stationId", "endTime");

-- CreateIndex
CREATE INDEX "StationStateLog_stationStatusReasonId_idx" ON "StationStateLog"("stationStatusReasonId");

-- CreateIndex
CREATE INDEX "StationStatusReason_siteId_idx" ON "StationStatusReason"("siteId");

-- CreateIndex
CREATE INDEX "StationStatusReason_categoryId_idx" ON "StationStatusReason"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "StationStatusReason_siteId_name_key" ON "StationStatusReason"("siteId", "name");

-- CreateIndex
CREATE INDEX "StationBlob_stationId_idx" ON "StationBlob"("stationId");

-- CreateIndex
CREATE UNIQUE INDEX "StationBlob_stationId_version_key" ON "StationBlob"("stationId", "version");

-- CreateIndex
CREATE INDEX "StationClassification_siteId_idx" ON "StationClassification"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "StationClassification_siteId_name_key" ON "StationClassification"("siteId", "name");

-- CreateIndex
CREATE INDEX "StationJob_stationId_idx" ON "StationJob"("stationId");

-- CreateIndex
CREATE INDEX "StationJob_jobId_idx" ON "StationJob"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "StationJob_stationId_jobId_key" ON "StationJob"("stationId", "jobId");

-- CreateIndex
CREATE INDEX "ProcessType_siteId_idx" ON "ProcessType"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessType_siteId_name_key" ON "ProcessType"("siteId", "name");

-- CreateIndex
CREATE INDEX "_ToolToToolClassification_B_index" ON "_ToolToToolClassification"("B");

-- CreateIndex
CREATE INDEX "_StationToStationClassification_B_index" ON "_StationToStationClassification"("B");

-- CreateIndex
CREATE INDEX "_StationToStationStatusReason_B_index" ON "_StationToStationStatusReason"("B");

-- CreateIndex
CREATE INDEX "_StationStatusReasonToWorkcenter_B_index" ON "_StationStatusReasonToWorkcenter"("B");

-- CreateIndex
CREATE INDEX "_ProcessTypeToStationStatusReason_B_index" ON "_ProcessTypeToStationStatusReason"("B");

-- CreateIndex
CREATE INDEX "InventoryItem_jobProductBlobId_idx" ON "InventoryItem"("jobProductBlobId");

-- CreateIndex
CREATE INDEX "Job_processTypeId_idx" ON "Job"("processTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "Station_currentJobId_key" ON "Station"("currentJobId");

-- CreateIndex
CREATE UNIQUE INDEX "Station_currentBlobId_key" ON "Station"("currentBlobId");

-- CreateIndex
CREATE UNIQUE INDEX "Tool_toolLocationId_key" ON "Tool"("toolLocationId");

-- CreateIndex
CREATE INDEX "Tool_toolStatusId_idx" ON "Tool"("toolStatusId");

-- CreateIndex
CREATE INDEX "Tool_toolLocationId_idx" ON "Tool"("toolLocationId");

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_jobProductBlobId_fkey" FOREIGN KEY ("jobProductBlobId") REFERENCES "JobProductBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tool" ADD CONSTRAINT "Tool_toolStatusId_fkey" FOREIGN KEY ("toolStatusId") REFERENCES "ToolStatus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tool" ADD CONSTRAINT "Tool_toolLocationId_fkey" FOREIGN KEY ("toolLocationId") REFERENCES "ToolLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_processTypeId_fkey" FOREIGN KEY ("processTypeId") REFERENCES "ProcessType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProduct" ADD CONSTRAINT "JobProduct_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProduct" ADD CONSTRAINT "JobProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProduct" ADD CONSTRAINT "JobProduct_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProduct" ADD CONSTRAINT "JobProduct_toolCavityId_fkey" FOREIGN KEY ("toolCavityId") REFERENCES "ToolCavity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProduct" ADD CONSTRAINT "JobProduct_currentBlobId_fkey" FOREIGN KEY ("currentBlobId") REFERENCES "JobProductBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProductBlob" ADD CONSTRAINT "JobProductBlob_jobProductId_fkey" FOREIGN KEY ("jobProductId") REFERENCES "JobProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolStatus" ADD CONSTRAINT "ToolStatus_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolClassification" ADD CONSTRAINT "ToolClassification_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolLocation" ADD CONSTRAINT "ToolLocation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Station" ADD CONSTRAINT "Station_currentJobId_fkey" FOREIGN KEY ("currentJobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Station" ADD CONSTRAINT "Station_currentBlobId_fkey" FOREIGN KEY ("currentBlobId") REFERENCES "StationBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_stationStatusReasonId_fkey" FOREIGN KEY ("stationStatusReasonId") REFERENCES "StationStatusReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStatusReason" ADD CONSTRAINT "StationStatusReason_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStatusReason" ADD CONSTRAINT "StationStatusReason_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "StationStatusCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationBlob" ADD CONSTRAINT "StationBlob_processTypeId_fkey" FOREIGN KEY ("processTypeId") REFERENCES "ProcessType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationBlob" ADD CONSTRAINT "StationBlob_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationClassification" ADD CONSTRAINT "StationClassification_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationJob" ADD CONSTRAINT "StationJob_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationJob" ADD CONSTRAINT "StationJob_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessType" ADD CONSTRAINT "ProcessType_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ToolToToolClassification" ADD CONSTRAINT "_ToolToToolClassification_A_fkey" FOREIGN KEY ("A") REFERENCES "Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ToolToToolClassification" ADD CONSTRAINT "_ToolToToolClassification_B_fkey" FOREIGN KEY ("B") REFERENCES "ToolClassification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StationToStationClassification" ADD CONSTRAINT "_StationToStationClassification_A_fkey" FOREIGN KEY ("A") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StationToStationClassification" ADD CONSTRAINT "_StationToStationClassification_B_fkey" FOREIGN KEY ("B") REFERENCES "StationClassification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StationToStationStatusReason" ADD CONSTRAINT "_StationToStationStatusReason_A_fkey" FOREIGN KEY ("A") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StationToStationStatusReason" ADD CONSTRAINT "_StationToStationStatusReason_B_fkey" FOREIGN KEY ("B") REFERENCES "StationStatusReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StationStatusReasonToWorkcenter" ADD CONSTRAINT "_StationStatusReasonToWorkcenter_A_fkey" FOREIGN KEY ("A") REFERENCES "StationStatusReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StationStatusReasonToWorkcenter" ADD CONSTRAINT "_StationStatusReasonToWorkcenter_B_fkey" FOREIGN KEY ("B") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProcessTypeToStationStatusReason" ADD CONSTRAINT "_ProcessTypeToStationStatusReason_A_fkey" FOREIGN KEY ("A") REFERENCES "ProcessType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProcessTypeToStationStatusReason" ADD CONSTRAINT "_ProcessTypeToStationStatusReason_B_fkey" FOREIGN KEY ("B") REFERENCES "StationStatusReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

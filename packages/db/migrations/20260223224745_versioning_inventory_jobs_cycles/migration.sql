/*
  Warnings:

  - You are about to drop the column `jobId` on the `Cycle` table. All the data in the column will be lost.
  - You are about to drop the column `standardCycleTime` on the `Cycle` table. All the data in the column will be lost.
  - You are about to drop the column `toolId` on the `Cycle` table. All the data in the column will be lost.
  - You are about to drop the column `activeCavities` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the column `attrs` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the column `description` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the column `nameAlt` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the column `partsPerCycle` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the column `standardCycleTime` on the `Job` table. All the data in the column will be lost.
  - The primary key for the `JobTool` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `attrs` on the `JobTool` table. All the data in the column will be lost.
  - You are about to drop the column `isActive` on the `JobTool` table. All the data in the column will be lost.
  - You are about to drop the column `attrs` on the `Material` table. All the data in the column will be lost.
  - You are about to drop the column `description` on the `Material` table. All the data in the column will be lost.
  - You are about to drop the column `externalNumber` on the `Material` table. All the data in the column will be lost.
  - You are about to drop the column `materialNumber` on the `Material` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `Material` table. All the data in the column will be lost.
  - You are about to drop the column `partId` on the `Material` table. All the data in the column will be lost.
  - You are about to drop the column `shortCode` on the `Material` table. All the data in the column will be lost.
  - You are about to drop the column `attrs` on the `Tool` table. All the data in the column will be lost.
  - You are about to drop the column `cavityCount` on the `Tool` table. All the data in the column will be lost.
  - You are about to drop the column `description` on the `Tool` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `Tool` table. All the data in the column will be lost.
  - You are about to drop the column `nameAlt` on the `Tool` table. All the data in the column will be lost.
  - You are about to drop the column `attrs` on the `ToolCavity` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `ToolCavity` table. All the data in the column will be lost.
  - You are about to drop the column `position` on the `ToolCavity` table. All the data in the column will be lost.
  - You are about to drop the column `partId` on the `WorkOrder` table. All the data in the column will be lost.
  - You are about to drop the `CyclePart` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobPart` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Part` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[currentBlobId]` on the table `Job` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[currentBlobId]` on the table `JobTool` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[jobId,toolId]` on the table `JobTool` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[currentBlobId]` on the table `Material` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[currentBlobId]` on the table `Tool` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[currentBlobId]` on the table `ToolCavity` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `jobBlobId` to the `Cycle` table without a default value. This is not possible if the table is not empty.
  - The required column `id` was added to the `JobTool` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - Added the required column `productId` to the `Material` table without a default value. This is not possible if the table is not empty.
  - Added the required column `productId` to the `WorkOrder` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Cycle" DROP CONSTRAINT "Cycle_jobId_fkey";

-- DropForeignKey
ALTER TABLE "Cycle" DROP CONSTRAINT "Cycle_toolId_fkey";

-- DropForeignKey
ALTER TABLE "CyclePart" DROP CONSTRAINT "CyclePart_cycleId_fkey";

-- DropForeignKey
ALTER TABLE "CyclePart" DROP CONSTRAINT "CyclePart_jobPartId_fkey";

-- DropForeignKey
ALTER TABLE "CyclePart" DROP CONSTRAINT "CyclePart_partId_fkey";

-- DropForeignKey
ALTER TABLE "JobPart" DROP CONSTRAINT "JobPart_jobId_fkey";

-- DropForeignKey
ALTER TABLE "JobPart" DROP CONSTRAINT "JobPart_partId_fkey";

-- DropForeignKey
ALTER TABLE "JobPart" DROP CONSTRAINT "JobPart_toolCavityId_fkey";

-- DropForeignKey
ALTER TABLE "JobPart" DROP CONSTRAINT "JobPart_toolId_fkey";

-- DropForeignKey
ALTER TABLE "Material" DROP CONSTRAINT "Material_partId_fkey";

-- DropForeignKey
ALTER TABLE "Part" DROP CONSTRAINT "Part_siteId_fkey";

-- DropForeignKey
ALTER TABLE "WorkOrder" DROP CONSTRAINT "WorkOrder_partId_fkey";

-- DropIndex
DROP INDEX "Cycle_jobId_idx";

-- DropIndex
DROP INDEX "Cycle_toolId_idx";

-- DropIndex
DROP INDEX "Job_siteId_name_key";

-- DropIndex
DROP INDEX "Material_partId_idx";

-- DropIndex
DROP INDEX "Material_siteId_materialNumber_key";

-- DropIndex
DROP INDEX "Tool_siteId_name_key";

-- DropIndex
DROP INDEX "ToolCavity_toolId_name_key";

-- DropIndex
DROP INDEX "WorkOrder_partId_idx";

-- AlterTable
ALTER TABLE "Cycle" DROP COLUMN "jobId",
DROP COLUMN "standardCycleTime",
DROP COLUMN "toolId",
ADD COLUMN     "jobBlobId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "Job" DROP COLUMN "activeCavities",
DROP COLUMN "attrs",
DROP COLUMN "description",
DROP COLUMN "name",
DROP COLUMN "nameAlt",
DROP COLUMN "partsPerCycle",
DROP COLUMN "standardCycleTime",
ADD COLUMN     "currentBlobId" UUID;

-- AlterTable
ALTER TABLE "JobTool" DROP CONSTRAINT "JobTool_pkey",
DROP COLUMN "attrs",
DROP COLUMN "isActive",
ADD COLUMN     "currentBlobId" UUID,
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "JobTool_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "Material" DROP COLUMN "attrs",
DROP COLUMN "description",
DROP COLUMN "externalNumber",
DROP COLUMN "materialNumber",
DROP COLUMN "name",
DROP COLUMN "partId",
DROP COLUMN "shortCode",
ADD COLUMN     "currentBlobId" UUID,
ADD COLUMN     "productId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "Tool" DROP COLUMN "attrs",
DROP COLUMN "cavityCount",
DROP COLUMN "description",
DROP COLUMN "name",
DROP COLUMN "nameAlt",
ADD COLUMN     "currentBlobId" UUID;

-- AlterTable
ALTER TABLE "ToolCavity" DROP COLUMN "attrs",
DROP COLUMN "name",
DROP COLUMN "position",
ADD COLUMN     "currentBlobId" UUID;

-- AlterTable
ALTER TABLE "WorkOrder" DROP COLUMN "partId",
ADD COLUMN     "productId" UUID NOT NULL;

-- DropTable
DROP TABLE "CyclePart";

-- DropTable
DROP TABLE "JobPart";

-- DropTable
DROP TABLE "Part";

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "currentBlobId" UUID,
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductBlob" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "externalSku" TEXT,
    "weight" DECIMAL(10,2),
    "weightUnits" "WeightUnit",
    "itemCost" DECIMAL(10,2),
    "laborCost" DECIMAL(10,2),
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "productId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialBlob" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT,
    "shortCode" TEXT,
    "materialNumber" TEXT NOT NULL,
    "description" TEXT,
    "externalNumber" TEXT,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "materialId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" UUID NOT NULL,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "cycleId" UUID NOT NULL,
    "jobItemBlobId" UUID,
    "productBlobId" UUID NOT NULL,
    "toolBlobId" UUID,
    "toolCavityBlobId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolBlob" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "cavityCount" INTEGER,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "toolId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolCavityBlob" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER,
    "toolCavityId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolCavityBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobBlob" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "standardCycle" DECIMAL(10,2),
    "productsPerCycle" INTEGER NOT NULL DEFAULT 1,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "jobId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobToolBlob" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "jobToolId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobToolBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobItem" (
    "id" UUID NOT NULL,
    "currentBlobId" UUID,
    "jobId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "toolId" UUID,
    "toolCavityId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "JobItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobItemBlob" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "jobItemId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobItemBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_CycleToJobToolBlob" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_CycleToJobToolBlob_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_CycleToToolBlob" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_CycleToToolBlob_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_InventoryItemToMaterialBlob" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_InventoryItemToMaterialBlob_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_currentBlobId_key" ON "Product"("currentBlobId");

-- CreateIndex
CREATE INDEX "ProductBlob_productId_idx" ON "ProductBlob"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductBlob_productId_version_key" ON "ProductBlob"("productId", "version");

-- CreateIndex
CREATE INDEX "MaterialBlob_materialId_idx" ON "MaterialBlob"("materialId");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialBlob_materialId_version_key" ON "MaterialBlob"("materialId", "version");

-- CreateIndex
CREATE INDEX "InventoryItem_cycleId_idx" ON "InventoryItem"("cycleId");

-- CreateIndex
CREATE INDEX "InventoryItem_jobItemBlobId_idx" ON "InventoryItem"("jobItemBlobId");

-- CreateIndex
CREATE INDEX "InventoryItem_productBlobId_idx" ON "InventoryItem"("productBlobId");

-- CreateIndex
CREATE INDEX "InventoryItem_toolBlobId_idx" ON "InventoryItem"("toolBlobId");

-- CreateIndex
CREATE INDEX "InventoryItem_toolCavityBlobId_idx" ON "InventoryItem"("toolCavityBlobId");

-- CreateIndex
CREATE INDEX "ToolBlob_toolId_idx" ON "ToolBlob"("toolId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolBlob_toolId_version_key" ON "ToolBlob"("toolId", "version");

-- CreateIndex
CREATE INDEX "ToolCavityBlob_toolCavityId_idx" ON "ToolCavityBlob"("toolCavityId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolCavityBlob_toolCavityId_version_key" ON "ToolCavityBlob"("toolCavityId", "version");

-- CreateIndex
CREATE INDEX "JobBlob_jobId_idx" ON "JobBlob"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobBlob_jobId_version_key" ON "JobBlob"("jobId", "version");

-- CreateIndex
CREATE INDEX "JobToolBlob_jobToolId_idx" ON "JobToolBlob"("jobToolId");

-- CreateIndex
CREATE UNIQUE INDEX "JobToolBlob_jobToolId_version_key" ON "JobToolBlob"("jobToolId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "JobItem_currentBlobId_key" ON "JobItem"("currentBlobId");

-- CreateIndex
CREATE INDEX "JobItem_jobId_idx" ON "JobItem"("jobId");

-- CreateIndex
CREATE INDEX "JobItem_productId_idx" ON "JobItem"("productId");

-- CreateIndex
CREATE INDEX "JobItem_toolId_idx" ON "JobItem"("toolId");

-- CreateIndex
CREATE INDEX "JobItem_toolCavityId_idx" ON "JobItem"("toolCavityId");

-- CreateIndex
CREATE INDEX "JobItemBlob_jobItemId_idx" ON "JobItemBlob"("jobItemId");

-- CreateIndex
CREATE UNIQUE INDEX "JobItemBlob_jobItemId_version_key" ON "JobItemBlob"("jobItemId", "version");

-- CreateIndex
CREATE INDEX "_CycleToJobToolBlob_B_index" ON "_CycleToJobToolBlob"("B");

-- CreateIndex
CREATE INDEX "_CycleToToolBlob_B_index" ON "_CycleToToolBlob"("B");

-- CreateIndex
CREATE INDEX "_InventoryItemToMaterialBlob_B_index" ON "_InventoryItemToMaterialBlob"("B");

-- CreateIndex
CREATE INDEX "Cycle_jobBlobId_idx" ON "Cycle"("jobBlobId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_currentBlobId_key" ON "Job"("currentBlobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobTool_currentBlobId_key" ON "JobTool"("currentBlobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobTool_jobId_toolId_key" ON "JobTool"("jobId", "toolId");

-- CreateIndex
CREATE UNIQUE INDEX "Material_currentBlobId_key" ON "Material"("currentBlobId");

-- CreateIndex
CREATE INDEX "Material_productId_idx" ON "Material"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "Tool_currentBlobId_key" ON "Tool"("currentBlobId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolCavity_currentBlobId_key" ON "ToolCavity"("currentBlobId");

-- CreateIndex
CREATE INDEX "WorkOrder_productId_idx" ON "WorkOrder"("productId");

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_jobBlobId_fkey" FOREIGN KEY ("jobBlobId") REFERENCES "JobBlob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_currentBlobId_fkey" FOREIGN KEY ("currentBlobId") REFERENCES "ProductBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductBlob" ADD CONSTRAINT "ProductBlob_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_currentBlobId_fkey" FOREIGN KEY ("currentBlobId") REFERENCES "MaterialBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialBlob" ADD CONSTRAINT "MaterialBlob_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_jobItemBlobId_fkey" FOREIGN KEY ("jobItemBlobId") REFERENCES "JobItemBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_productBlobId_fkey" FOREIGN KEY ("productBlobId") REFERENCES "ProductBlob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_toolBlobId_fkey" FOREIGN KEY ("toolBlobId") REFERENCES "ToolBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_toolCavityBlobId_fkey" FOREIGN KEY ("toolCavityBlobId") REFERENCES "ToolCavityBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tool" ADD CONSTRAINT "Tool_currentBlobId_fkey" FOREIGN KEY ("currentBlobId") REFERENCES "ToolBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolBlob" ADD CONSTRAINT "ToolBlob_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCavity" ADD CONSTRAINT "ToolCavity_currentBlobId_fkey" FOREIGN KEY ("currentBlobId") REFERENCES "ToolCavityBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCavityBlob" ADD CONSTRAINT "ToolCavityBlob_toolCavityId_fkey" FOREIGN KEY ("toolCavityId") REFERENCES "ToolCavity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_currentBlobId_fkey" FOREIGN KEY ("currentBlobId") REFERENCES "JobBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobBlob" ADD CONSTRAINT "JobBlob_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTool" ADD CONSTRAINT "JobTool_currentBlobId_fkey" FOREIGN KEY ("currentBlobId") REFERENCES "JobToolBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobToolBlob" ADD CONSTRAINT "JobToolBlob_jobToolId_fkey" FOREIGN KEY ("jobToolId") REFERENCES "JobTool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobItem" ADD CONSTRAINT "JobItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobItem" ADD CONSTRAINT "JobItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobItem" ADD CONSTRAINT "JobItem_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobItem" ADD CONSTRAINT "JobItem_toolCavityId_fkey" FOREIGN KEY ("toolCavityId") REFERENCES "ToolCavity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobItem" ADD CONSTRAINT "JobItem_currentBlobId_fkey" FOREIGN KEY ("currentBlobId") REFERENCES "JobItemBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobItemBlob" ADD CONSTRAINT "JobItemBlob_jobItemId_fkey" FOREIGN KEY ("jobItemId") REFERENCES "JobItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CycleToJobToolBlob" ADD CONSTRAINT "_CycleToJobToolBlob_A_fkey" FOREIGN KEY ("A") REFERENCES "Cycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CycleToJobToolBlob" ADD CONSTRAINT "_CycleToJobToolBlob_B_fkey" FOREIGN KEY ("B") REFERENCES "JobToolBlob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CycleToToolBlob" ADD CONSTRAINT "_CycleToToolBlob_A_fkey" FOREIGN KEY ("A") REFERENCES "Cycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CycleToToolBlob" ADD CONSTRAINT "_CycleToToolBlob_B_fkey" FOREIGN KEY ("B") REFERENCES "ToolBlob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_InventoryItemToMaterialBlob" ADD CONSTRAINT "_InventoryItemToMaterialBlob_A_fkey" FOREIGN KEY ("A") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_InventoryItemToMaterialBlob" ADD CONSTRAINT "_InventoryItemToMaterialBlob_B_fkey" FOREIGN KEY ("B") REFERENCES "MaterialBlob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

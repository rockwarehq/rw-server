/*
  Warnings:

  - You are about to drop the column `locationId` on the `Station` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[workcenterId,name]` on the table `Station` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `workcenterId` to the `Station` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Station" DROP CONSTRAINT "Station_locationId_fkey";

-- DropIndex
DROP INDEX "Station_locationId_idx";

-- DropIndex
DROP INDEX "Station_locationId_name_key";

-- AlterTable
ALTER TABLE "Datasource" ADD COLUMN     "siteId" UUID,
ALTER COLUMN "locationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Gateway" ADD COLUMN     "siteId" UUID,
ALTER COLUMN "locationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Station" DROP COLUMN "locationId",
ADD COLUMN     "workcenterId" UUID NOT NULL;

-- CreateTable
CREATE TABLE "Site" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workspaceId" UUID NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workcenter" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "siteId" UUID NOT NULL,
    "parentId" UUID,

    CONSTRAINT "Workcenter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Site_workspaceId_idx" ON "Site"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Site_workspaceId_name_key" ON "Site"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Workcenter_siteId_idx" ON "Workcenter"("siteId");

-- CreateIndex
CREATE INDEX "Workcenter_parentId_idx" ON "Workcenter"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Workcenter_siteId_parentId_name_key" ON "Workcenter"("siteId", "parentId", "name");

-- CreateIndex
CREATE INDEX "Datasource_siteId_idx" ON "Datasource"("siteId");

-- CreateIndex
CREATE INDEX "Gateway_siteId_idx" ON "Gateway"("siteId");

-- CreateIndex
CREATE INDEX "Station_workcenterId_idx" ON "Station"("workcenterId");

-- CreateIndex
CREATE UNIQUE INDEX "Station_workcenterId_name_key" ON "Station"("workcenterId", "name");

-- AddForeignKey
ALTER TABLE "Datasource" ADD CONSTRAINT "Datasource_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gateway" ADD CONSTRAINT "Gateway_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Station" ADD CONSTRAINT "Station_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workcenter" ADD CONSTRAINT "Workcenter_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workcenter" ADD CONSTRAINT "Workcenter_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

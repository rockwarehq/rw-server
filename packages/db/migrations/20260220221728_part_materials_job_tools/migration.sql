/*
  Warnings:

  - You are about to drop the column `cavityId` on the `CyclePart` table. All the data in the column will be lost.
  - You are about to drop the column `materialId` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the column `toolId` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the `Cavity` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `partId` to the `Material` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Tool` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Cavity" DROP CONSTRAINT "Cavity_jobId_fkey";

-- DropForeignKey
ALTER TABLE "Cavity" DROP CONSTRAINT "Cavity_partId_fkey";

-- DropForeignKey
ALTER TABLE "CyclePart" DROP CONSTRAINT "CyclePart_cavityId_fkey";

-- DropForeignKey
ALTER TABLE "CyclePart" DROP CONSTRAINT "CyclePart_cycleId_fkey";

-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "Job_materialId_fkey";

-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "Job_toolId_fkey";

-- AlterTable
ALTER TABLE "Cycle" ALTER COLUMN "end" DROP NOT NULL;

-- AlterTable
ALTER TABLE "CyclePart" DROP COLUMN "cavityId",
ADD COLUMN     "jobPartId" UUID;

-- AlterTable
ALTER TABLE "Job" DROP COLUMN "materialId",
DROP COLUMN "toolId";

-- AlterTable
ALTER TABLE "Material" ADD COLUMN     "partId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "Tool" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- DropTable
DROP TABLE "Cavity";

-- CreateTable
CREATE TABLE "ToolCavity" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "toolId" UUID NOT NULL,

    CONSTRAINT "ToolCavity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobTool" (
    "jobId" UUID NOT NULL,
    "toolId" UUID NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "attrs" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "JobTool_pkey" PRIMARY KEY ("jobId","toolId")
);

-- CreateTable
CREATE TABLE "JobPart" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "jobId" UUID NOT NULL,
    "partId" UUID NOT NULL,
    "toolId" UUID,
    "toolCavityId" UUID,

    CONSTRAINT "JobPart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ToolCavity_toolId_idx" ON "ToolCavity"("toolId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolCavity_toolId_name_key" ON "ToolCavity"("toolId", "name");

-- CreateIndex
CREATE INDEX "JobTool_toolId_idx" ON "JobTool"("toolId");

-- CreateIndex
CREATE INDEX "JobPart_jobId_idx" ON "JobPart"("jobId");

-- CreateIndex
CREATE INDEX "JobPart_partId_idx" ON "JobPart"("partId");

-- CreateIndex
CREATE INDEX "JobPart_toolId_idx" ON "JobPart"("toolId");

-- CreateIndex
CREATE INDEX "JobPart_toolCavityId_idx" ON "JobPart"("toolCavityId");

-- CreateIndex
CREATE INDEX "Cycle_jobId_idx" ON "Cycle"("jobId");

-- CreateIndex
CREATE INDEX "Cycle_orderId_idx" ON "Cycle"("orderId");

-- CreateIndex
CREATE INDEX "Cycle_toolId_idx" ON "Cycle"("toolId");

-- CreateIndex
CREATE INDEX "CyclePart_jobPartId_idx" ON "CyclePart"("jobPartId");

-- CreateIndex
CREATE INDEX "Material_partId_idx" ON "Material"("partId");

-- CreateIndex
CREATE INDEX "WorkOrder_partId_idx" ON "WorkOrder"("partId");

-- AddForeignKey
ALTER TABLE "CyclePart" ADD CONSTRAINT "CyclePart_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CyclePart" ADD CONSTRAINT "CyclePart_jobPartId_fkey" FOREIGN KEY ("jobPartId") REFERENCES "JobPart"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCavity" ADD CONSTRAINT "ToolCavity_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTool" ADD CONSTRAINT "JobTool_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTool" ADD CONSTRAINT "JobTool_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobPart" ADD CONSTRAINT "JobPart_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobPart" ADD CONSTRAINT "JobPart_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobPart" ADD CONSTRAINT "JobPart_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobPart" ADD CONSTRAINT "JobPart_toolCavityId_fkey" FOREIGN KEY ("toolCavityId") REFERENCES "ToolCavity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

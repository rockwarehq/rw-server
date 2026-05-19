/*
  Warnings:

  - You are about to drop the column `currentBlobId` on the `JobTool` table. All the data in the column will be lost.
  - You are about to drop the `JobToolBlob` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `_CycleToJobToolBlob` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "JobTool" DROP CONSTRAINT "JobTool_currentBlobId_fkey";

-- DropForeignKey
ALTER TABLE "JobToolBlob" DROP CONSTRAINT "JobToolBlob_jobToolId_fkey";

-- DropForeignKey
ALTER TABLE "_CycleToJobToolBlob" DROP CONSTRAINT "_CycleToJobToolBlob_A_fkey";

-- DropForeignKey
ALTER TABLE "_CycleToJobToolBlob" DROP CONSTRAINT "_CycleToJobToolBlob_B_fkey";

-- DropIndex
DROP INDEX "JobTool_currentBlobId_key";

-- AlterTable
ALTER TABLE "JobTool" DROP COLUMN "currentBlobId",
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- DropTable
DROP TABLE "JobToolBlob";

-- DropTable
DROP TABLE "_CycleToJobToolBlob";

-- CreateTable
CREATE TABLE "_CycleToJobTool" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_CycleToJobTool_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_CycleToJobTool_B_index" ON "_CycleToJobTool"("B");

-- AddForeignKey
ALTER TABLE "_CycleToJobTool" ADD CONSTRAINT "_CycleToJobTool_A_fkey" FOREIGN KEY ("A") REFERENCES "Cycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CycleToJobTool" ADD CONSTRAINT "_CycleToJobTool_B_fkey" FOREIGN KEY ("B") REFERENCES "JobTool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

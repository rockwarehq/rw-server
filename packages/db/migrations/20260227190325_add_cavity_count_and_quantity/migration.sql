-- AlterTable
ALTER TABLE "JobProductBlob" ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ToolBlob" ADD COLUMN     "cavityCount" INTEGER;

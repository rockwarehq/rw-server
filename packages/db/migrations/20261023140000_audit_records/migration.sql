-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'RECORD_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'RECORD_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'RECORD_DELETED';

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "previousVersionId" UUID,
ADD COLUMN     "versionId" UUID;

-- AlterTable
ALTER TABLE "EmployeeVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "JobProductVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "JobVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "MaterialVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "ProductMaterialVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "ProductVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "StationVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "ToolCavityVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "ToolVersion" ADD COLUMN     "createdById" UUID;


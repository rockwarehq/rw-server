-- CreateEnum
CREATE TYPE "DatasourceStatus" AS ENUM ('DRAFT', 'ACTIVE');

-- AlterTable
ALTER TABLE "Datasource" ADD COLUMN     "status" "DatasourceStatus" NOT NULL DEFAULT 'DRAFT',
ALTER COLUMN "connection" SET DEFAULT '{}';

-- Update existing datasources to ACTIVE (they already have connection info)
UPDATE "Datasource" SET "status" = 'ACTIVE';

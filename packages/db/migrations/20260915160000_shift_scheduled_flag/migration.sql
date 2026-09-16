-- AlterTable
ALTER TABLE "ShiftDefinition" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ShiftOverride" DROP COLUMN "cancelled",
ADD COLUMN     "isScheduled" BOOLEAN;


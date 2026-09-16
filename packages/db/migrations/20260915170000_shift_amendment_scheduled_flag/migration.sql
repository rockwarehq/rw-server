-- AlterTable
ALTER TABLE "ShiftAmendment" DROP COLUMN "cancelled",
ADD COLUMN     "isScheduled" BOOLEAN;


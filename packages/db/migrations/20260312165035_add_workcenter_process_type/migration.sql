-- AlterTable
ALTER TABLE "Workcenter" ADD COLUMN     "processTypeId" UUID;

-- AddForeignKey
ALTER TABLE "Workcenter" ADD CONSTRAINT "Workcenter_processTypeId_fkey" FOREIGN KEY ("processTypeId") REFERENCES "ProcessType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

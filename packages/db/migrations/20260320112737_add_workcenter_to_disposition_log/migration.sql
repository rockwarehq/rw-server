-- AlterTable
ALTER TABLE "ItemDispositionLog" ADD COLUMN     "workcenterId" UUID;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

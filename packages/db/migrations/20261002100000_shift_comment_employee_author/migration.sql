-- AlterTable
ALTER TABLE "ShiftComment" ADD COLUMN     "createdByEmployeeId" UUID,
ADD COLUMN     "createdByEmployeeVersionId" UUID;

-- AddForeignKey
ALTER TABLE "ShiftComment" ADD CONSTRAINT "ShiftComment_createdByEmployeeId_fkey" FOREIGN KEY ("createdByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

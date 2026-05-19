-- AlterTable: Replace rotationStartShift integer with rotationStartDefinitionId FK
ALTER TABLE "ShiftAssignment" DROP COLUMN "rotationStartShift";
ALTER TABLE "ShiftAssignment" ADD COLUMN "rotationStartDefinitionId" UUID;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_rotationStartDefinitionId_fkey" FOREIGN KEY ("rotationStartDefinitionId") REFERENCES "ShiftDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "workspaceId" UUID;

-- CreateIndex
CREATE INDEX "Location_workspaceId_idx" ON "Location"("workspaceId");

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

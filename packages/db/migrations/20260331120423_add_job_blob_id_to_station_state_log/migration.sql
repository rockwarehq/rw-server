-- AlterTable
ALTER TABLE "StationStateLog" ADD COLUMN     "jobBlobId" UUID;

-- CreateIndex
CREATE INDEX "StationStateLog_jobBlobId_idx" ON "StationStateLog"("jobBlobId");

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_jobBlobId_fkey" FOREIGN KEY ("jobBlobId") REFERENCES "JobBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterEnum
ALTER TYPE "BucketEntityType" ADD VALUE 'JOB';

-- CreateTable
CREATE TABLE "StationJobLog" (
    "id" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "jobBlobId" UUID NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "standardCycle" DECIMAL(10,2),
    "lastAccumulatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StationJobLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StationJobLog_stationId_idx" ON "StationJobLog"("stationId");

-- CreateIndex
CREATE INDEX "StationJobLog_stationId_endTime_idx" ON "StationJobLog"("stationId", "endTime");

-- CreateIndex
CREATE INDEX "StationJobLog_jobId_idx" ON "StationJobLog"("jobId");

-- AddForeignKey
ALTER TABLE "StationJobLog" ADD CONSTRAINT "StationJobLog_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationJobLog" ADD CONSTRAINT "StationJobLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

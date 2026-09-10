-- CreateEnum
CREATE TYPE "JobHistoryAmendmentStatus" AS ENUM ('PENDING_REBUILD', 'APPLIED', 'FAILED');

-- CreateTable
CREATE TABLE "JobHistoryAmendment" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "jobId" UUID,
    "jobVersionId" UUID,
    "fromTime" TIMESTAMPTZ(3) NOT NULL,
    "toTime" TIMESTAMPTZ(3),
    "previousTimeline" JSONB NOT NULL,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "status" "JobHistoryAmendmentStatus" NOT NULL DEFAULT 'PENDING_REBUILD',
    "rebuildError" TEXT,
    "rebuiltAt" TIMESTAMPTZ(3),
    "source" "ActionSource" NOT NULL DEFAULT 'MANUAL',
    "actorEmployeeId" UUID,
    "actorUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "JobHistoryAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobHistoryAmendment_stationId_createdAt_idx" ON "JobHistoryAmendment"("stationId", "createdAt");

-- CreateIndex
CREATE INDEX "JobHistoryAmendment_siteId_status_idx" ON "JobHistoryAmendment"("siteId", "status");

-- AddForeignKey
ALTER TABLE "JobHistoryAmendment" ADD CONSTRAINT "JobHistoryAmendment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobHistoryAmendment" ADD CONSTRAINT "JobHistoryAmendment_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobHistoryAmendment" ADD CONSTRAINT "JobHistoryAmendment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- CreateEnum
CREATE TYPE "StationEventExecutionStatus" AS ENUM ('RUNNING', 'FAILED', 'SUCCEEDED');

-- CreateTable
CREATE TABLE "StationEventExecution" (
    "id" UUID NOT NULL,
    "status" "StationEventExecutionStatus" NOT NULL DEFAULT 'RUNNING',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "stationEventId" UUID NOT NULL,

    CONSTRAINT "StationEventExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StationEventExecution_stationEventId_createdAt_idx" ON "StationEventExecution"("stationEventId", "createdAt");

-- CreateIndex
CREATE INDEX "StationEventExecution_stationEventId_status_idx" ON "StationEventExecution"("stationEventId", "status");

-- AddForeignKey
ALTER TABLE "StationEventExecution" ADD CONSTRAINT "StationEventExecution_stationEventId_fkey" FOREIGN KEY ("stationEventId") REFERENCES "StationEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

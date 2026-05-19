-- CreateTable
CREATE TABLE "StationEvent" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "stationId" UUID NOT NULL,

    CONSTRAINT "StationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StationEvent_stationId_enabled_idx" ON "StationEvent"("stationId", "enabled");

-- CreateIndex
CREATE INDEX "StationEvent_stationId_createdAt_idx" ON "StationEvent"("stationId", "createdAt");

-- AddForeignKey
ALTER TABLE "StationEvent" ADD CONSTRAINT "StationEvent_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

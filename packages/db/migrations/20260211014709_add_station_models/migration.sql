-- CreateEnum
CREATE TYPE "StationStatus" AS ENUM ('RUNNING', 'OVERCYCLE', 'PLANNED_DOWN', 'UNPLANNED_DOWN', 'CHANGEOVER');

-- CreateTable
CREATE TABLE "Station" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "locationId" UUID NOT NULL,

    CONSTRAINT "Station_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationStatusLog" (
    "id" UUID NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "status" "StationStatus" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "stationId" UUID NOT NULL,

    CONSTRAINT "StationStatusLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusReason" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workspaceId" UUID NOT NULL,

    CONSTRAINT "StatusReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationDatasource" (
    "id" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "datasourceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationDatasource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Station_locationId_idx" ON "Station"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "Station_locationId_name_key" ON "Station"("locationId", "name");

-- CreateIndex
CREATE INDEX "StationStatusLog_stationId_idx" ON "StationStatusLog"("stationId");

-- CreateIndex
CREATE INDEX "StationStatusLog_stationId_endTime_idx" ON "StationStatusLog"("stationId", "endTime");

-- CreateIndex
CREATE INDEX "StatusReason_workspaceId_idx" ON "StatusReason"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "StatusReason_workspaceId_label_key" ON "StatusReason"("workspaceId", "label");

-- CreateIndex
CREATE INDEX "StationDatasource_stationId_idx" ON "StationDatasource"("stationId");

-- CreateIndex
CREATE INDEX "StationDatasource_datasourceId_idx" ON "StationDatasource"("datasourceId");

-- CreateIndex
CREATE UNIQUE INDEX "StationDatasource_stationId_datasourceId_key" ON "StationDatasource"("stationId", "datasourceId");

-- AddForeignKey
ALTER TABLE "Station" ADD CONSTRAINT "Station_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStatusLog" ADD CONSTRAINT "StationStatusLog_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusReason" ADD CONSTRAINT "StatusReason_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationDatasource" ADD CONSTRAINT "StationDatasource_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationDatasource" ADD CONSTRAINT "StationDatasource_datasourceId_fkey" FOREIGN KEY ("datasourceId") REFERENCES "Datasource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

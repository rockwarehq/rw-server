-- CreateEnum
CREATE TYPE "CycleStatus" AS ENUM ('DISCARD', 'BAD', 'GOOD');

-- CreateEnum
CREATE TYPE "WeightUnit" AS ENUM ('KG', 'LB', 'G', 'OZ');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Cycle" (
    "id" UUID NOT NULL,
    "rejectNumber" INTEGER NOT NULL DEFAULT 0,
    "cycleStatus" "CycleStatus" NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "equipmentStart" TIMESTAMP(3),
    "equipmentEnd" TIMESTAMP(3),
    "standardCycleTime" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "siteId" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "orderId" UUID,
    "jobId" UUID NOT NULL,
    "toolId" UUID,

    CONSTRAINT "Cycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CyclePart" (
    "id" UUID NOT NULL,
    "cavityName" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "partCost" DECIMAL(10,2) NOT NULL,
    "laborCost" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "cycleId" UUID NOT NULL,
    "partId" UUID NOT NULL,
    "cavityId" UUID,

    CONSTRAINT "CyclePart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Part" (
    "id" UUID NOT NULL,
    "name" TEXT,
    "partNumber" TEXT NOT NULL,
    "description" TEXT,
    "externalPartNumber" TEXT,
    "partNumberAlt" TEXT,
    "weight" DECIMAL(10,2),
    "weightUnits" "WeightUnit",
    "partCost" DECIMAL(10,2),
    "laborCost" DECIMAL(10,2),
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tool" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "nameAlt" TEXT,
    "cavityCount" INTEGER,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "siteId" UUID NOT NULL,

    CONSTRAINT "Tool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Material" (
    "id" UUID NOT NULL,
    "name" TEXT,
    "shortCode" TEXT,
    "materialNumber" TEXT NOT NULL,
    "description" TEXT,
    "externalNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "siteId" UUID NOT NULL,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameAlt" TEXT,
    "description" TEXT,
    "standardCycleTime" DECIMAL(10,2),
    "partsPerCycle" INTEGER NOT NULL DEFAULT 1,
    "activeCavities" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "siteId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "toolId" UUID,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cavity" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "jobId" UUID NOT NULL,
    "partId" UUID NOT NULL,

    CONSTRAINT "Cavity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftPattern" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "useEndDateForBusinessDate" BOOLEAN NOT NULL DEFAULT true,
    "totalDaysInRotation" INTEGER NOT NULL DEFAULT 8,
    "startOnDayOfWeek" TEXT,
    "clonedFromId" UUID,
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftPattern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftDefinition" (
    "id" UUID NOT NULL,
    "dayOfRotation" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "durationHrs" DOUBLE PRECISION NOT NULL,
    "shiftName" TEXT NOT NULL,
    "patternId" UUID NOT NULL,

    CONSTRAINT "ShiftDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftAssignment" (
    "id" UUID NOT NULL,
    "patternId" UUID NOT NULL,
    "rotationStartDate" TIMESTAMP(3) NOT NULL,
    "rotationEndDate" TIMESTAMP(3),
    "rotationStartShift" INTEGER NOT NULL DEFAULT 1,
    "siteId" UUID NOT NULL,
    "workCenterId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrder" (
    "id" UUID NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'PENDING',
    "targetQuantity" INTEGER NOT NULL,
    "completedQuantity" INTEGER NOT NULL DEFAULT 0,
    "scrapQuantity" INTEGER NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "siteId" UUID NOT NULL,
    "jobId" UUID,
    "partId" UUID NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "WorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Cycle_stationId_end_idx" ON "Cycle"("stationId", "end");

-- CreateIndex
CREATE INDEX "Cycle_siteId_end_idx" ON "Cycle"("siteId", "end");

-- CreateIndex
CREATE INDEX "CyclePart_cycleId_idx" ON "CyclePart"("cycleId");

-- CreateIndex
CREATE INDEX "CyclePart_partId_idx" ON "CyclePart"("partId");

-- CreateIndex
CREATE UNIQUE INDEX "Part_siteId_partNumber_key" ON "Part"("siteId", "partNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Tool_siteId_name_key" ON "Tool"("siteId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Material_siteId_materialNumber_key" ON "Material"("siteId", "materialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Job_siteId_name_key" ON "Job"("siteId", "name");

-- CreateIndex
CREATE INDEX "Cavity_jobId_idx" ON "Cavity"("jobId");

-- CreateIndex
CREATE INDEX "ShiftDefinition_patternId_dayOfRotation_idx" ON "ShiftDefinition"("patternId", "dayOfRotation");

-- CreateIndex
CREATE INDEX "ShiftAssignment_siteId_idx" ON "ShiftAssignment"("siteId");

-- CreateIndex
CREATE INDEX "ShiftAssignment_workCenterId_idx" ON "ShiftAssignment"("workCenterId");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftAssignment_patternId_key" ON "ShiftAssignment"("patternId");

-- CreateIndex
CREATE INDEX "WorkOrder_jobId_idx" ON "WorkOrder"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_siteId_orderNumber_key" ON "WorkOrder"("siteId", "orderNumber");

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "WorkOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CyclePart" ADD CONSTRAINT "CyclePart_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CyclePart" ADD CONSTRAINT "CyclePart_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CyclePart" ADD CONSTRAINT "CyclePart_cavityId_fkey" FOREIGN KEY ("cavityId") REFERENCES "Cavity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tool" ADD CONSTRAINT "Tool_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cavity" ADD CONSTRAINT "Cavity_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cavity" ADD CONSTRAINT "Cavity_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftPattern" ADD CONSTRAINT "ShiftPattern_clonedFromId_fkey" FOREIGN KEY ("clonedFromId") REFERENCES "ShiftPattern"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftPattern" ADD CONSTRAINT "ShiftPattern_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftDefinition" ADD CONSTRAINT "ShiftDefinition_patternId_fkey" FOREIGN KEY ("patternId") REFERENCES "ShiftPattern"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_patternId_fkey" FOREIGN KEY ("patternId") REFERENCES "ShiftPattern"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_workCenterId_fkey" FOREIGN KEY ("workCenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

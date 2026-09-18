-- CreateTable
CREATE TABLE "ShiftSignoff" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "shiftInstanceId" UUID NOT NULL,
    "workcenterId" UUID NOT NULL,
    "postedById" UUID,
    "postedAt" TIMESTAMPTZ(3) NOT NULL,
    "reopenedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ShiftSignoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShiftSignoff_shiftInstanceId_workcenterId_key" ON "ShiftSignoff"("shiftInstanceId", "workcenterId");

-- CreateIndex
CREATE INDEX "ShiftSignoff_workcenterId_idx" ON "ShiftSignoff"("workcenterId");

-- AddForeignKey
ALTER TABLE "ShiftSignoff" ADD CONSTRAINT "ShiftSignoff_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSignoff" ADD CONSTRAINT "ShiftSignoff_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSignoff" ADD CONSTRAINT "ShiftSignoff_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSignoff" ADD CONSTRAINT "ShiftSignoff_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSignoff" ADD CONSTRAINT "ShiftSignoff_reopenedById_fkey" FOREIGN KEY ("reopenedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

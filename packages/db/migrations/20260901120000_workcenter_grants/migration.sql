-- CreateEnum
CREATE TYPE "WorkcenterAccess" AS ENUM ('READ', 'WRITE');

-- CreateTable
CREATE TABLE "WorkcenterGrant" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "workcenterId" UUID NOT NULL,
    "access" "WorkcenterAccess" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkcenterGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkcenterGrant_membershipId_workcenterId_key" ON "WorkcenterGrant"("membershipId", "workcenterId");

-- CreateIndex
CREATE INDEX "WorkcenterGrant_workcenterId_idx" ON "WorkcenterGrant"("workcenterId");

-- AddForeignKey
ALTER TABLE "WorkcenterGrant" ADD CONSTRAINT "WorkcenterGrant_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "WorkspaceMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkcenterGrant" ADD CONSTRAINT "WorkcenterGrant_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

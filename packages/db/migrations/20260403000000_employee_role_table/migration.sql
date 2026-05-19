-- Clear test employee data (role FK will change shape)
DELETE FROM "EmployeeBlob";
DELETE FROM "Employee";

-- Drop the old enum column and type (frees the name)
ALTER TABLE "EmployeeBlob" DROP COLUMN "role";
DROP TYPE "EmployeeRole";

-- CreateTable
CREATE TABLE "EmployeeRole" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeRole_siteId_name_key" ON "EmployeeRole"("siteId", "name");
CREATE INDEX "EmployeeRole_siteId_idx" ON "EmployeeRole"("siteId");

-- AddForeignKey
ALTER TABLE "EmployeeRole" ADD CONSTRAINT "EmployeeRole_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add roleId column (no rows, so NOT NULL is safe)
ALTER TABLE "EmployeeBlob" ADD COLUMN "roleId" UUID NOT NULL;

-- AddForeignKey
ALTER TABLE "EmployeeBlob" ADD CONSTRAINT "EmployeeBlob_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "EmployeeRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

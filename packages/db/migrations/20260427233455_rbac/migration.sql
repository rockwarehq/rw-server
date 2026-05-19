/*
  Warnings:

  - You are about to drop the column `currentBlobId` on the `Employee` table. All the data in the column will be lost.
  - You are about to drop the column `employeeNumber` on the `Employee` table. All the data in the column will be lost.
  - You are about to drop the column `firstName` on the `Employee` table. All the data in the column will be lost.
  - You are about to drop the column `lastName` on the `Employee` table. All the data in the column will be lost.
  - You are about to drop the column `siteId` on the `Employee` table. All the data in the column will be lost.
  - You are about to drop the column `username` on the `Employee` table. All the data in the column will be lost.
  - You are about to drop the column `employeeBlobId` on the `StationLogonSession` table. All the data in the column will be lost.
  - You are about to drop the column `role` on the `WorkspaceMember` table. All the data in the column will be lost.
  - You are about to drop the `EmployeeBlob` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[versionId]` on the table `Employee` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[workspaceId,employeeId]` on the table `WorkspaceMember` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `workspaceId` to the `Employee` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "RoleScope" AS ENUM ('WORKSPACE', 'SITE');

-- CreateEnum
CREATE TYPE "SystemRole" AS ENUM ('SUPPORT', 'ENGINEER');

-- DropForeignKey
ALTER TABLE "Employee" DROP CONSTRAINT "Employee_currentBlobId_fkey";

-- DropForeignKey
ALTER TABLE "Employee" DROP CONSTRAINT "Employee_siteId_fkey";

-- DropForeignKey
ALTER TABLE "EmployeeBlob" DROP CONSTRAINT "EmployeeBlob_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "EmployeeBlob" DROP CONSTRAINT "EmployeeBlob_roleId_fkey";

-- DropForeignKey
ALTER TABLE "StationLogonSession" DROP CONSTRAINT "StationLogonSession_employeeBlobId_fkey";

-- DropIndex
DROP INDEX "Employee_currentBlobId_key";

-- DropIndex
DROP INDEX "Employee_siteId_employeeNumber_key";

-- DropIndex
DROP INDEX "Employee_siteId_status_idx";

-- DropIndex
DROP INDEX "Employee_siteId_username_key";

-- AlterTable
ALTER TABLE "Employee" DROP COLUMN "currentBlobId",
DROP COLUMN "employeeNumber",
DROP COLUMN "firstName",
DROP COLUMN "lastName",
DROP COLUMN "siteId",
DROP COLUMN "username",
ADD COLUMN     "versionId" UUID,
ADD COLUMN     "workspaceId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "EmployeeRole" ADD COLUMN     "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "StationLogonSession" DROP COLUMN "employeeBlobId",
ADD COLUMN     "versionId" UUID;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "systemRole" "SystemRole";

-- AlterTable
ALTER TABLE "WorkspaceMember" DROP COLUMN "role",
ADD COLUMN     "employeeId" UUID;

-- DropTable
DROP TABLE "EmployeeBlob";

-- DropEnum
DROP TYPE "WorkspaceRole";

-- CreateTable
CREATE TABLE "EmployeeVersion" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "employeeNumber" TEXT,
    "pinHash" TEXT,
    "badgeNumber" TEXT,
    "employeeId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeSiteAccess" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmployeeSiteAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" "RoleScope" NOT NULL,
    "permissions" TEXT[],
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleAssignment" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "siteId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeVersion_employeeId_idx" ON "EmployeeVersion"("employeeId");

-- CreateIndex
CREATE INDEX "EmployeeVersion_badgeNumber_idx" ON "EmployeeVersion"("badgeNumber");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeVersion_employeeId_version_key" ON "EmployeeVersion"("employeeId", "version");

-- CreateIndex
CREATE INDEX "EmployeeSiteAccess_siteId_status_idx" ON "EmployeeSiteAccess"("siteId", "status");

-- CreateIndex
CREATE INDEX "EmployeeSiteAccess_roleId_idx" ON "EmployeeSiteAccess"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeSiteAccess_employeeId_siteId_key" ON "EmployeeSiteAccess"("employeeId", "siteId");

-- CreateIndex
CREATE INDEX "Role_workspaceId_idx" ON "Role"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_workspaceId_name_scope_key" ON "Role"("workspaceId", "name", "scope");

-- CreateIndex
CREATE INDEX "RoleAssignment_membershipId_idx" ON "RoleAssignment"("membershipId");

-- CreateIndex
CREATE INDEX "RoleAssignment_siteId_idx" ON "RoleAssignment"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_versionId_key" ON "Employee"("versionId");

-- CreateIndex
CREATE INDEX "Employee_workspaceId_status_idx" ON "Employee"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_employeeId_key" ON "WorkspaceMember"("workspaceId", "employeeId");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "EmployeeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeVersion" ADD CONSTRAINT "EmployeeVersion_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSiteAccess" ADD CONSTRAINT "EmployeeSiteAccess_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSiteAccess" ADD CONSTRAINT "EmployeeSiteAccess_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSiteAccess" ADD CONSTRAINT "EmployeeSiteAccess_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "EmployeeRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLogonSession" ADD CONSTRAINT "StationLogonSession_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "EmployeeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "WorkspaceMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "MaterialShiftUsage_shiftInstanceId_stationId_jobId_productId_ma" RENAME TO "MaterialShiftUsage_shiftInstanceId_stationId_jobId_productI_key";

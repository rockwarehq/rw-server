-- Refresh-token reuse grace window: rotation marker + audit actions.

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN "rotatedAt" TIMESTAMPTZ(3);
ALTER TABLE "DisplayRefreshToken" ADD COLUMN "rotatedAt" TIMESTAMPTZ(3);

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'REFRESH_REUSE_GRACE';
ALTER TYPE "AuditAction" ADD VALUE 'REFRESH_REUSE_DETECTED';

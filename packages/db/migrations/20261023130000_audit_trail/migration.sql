-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'RECORD_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'RECORD_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'RECORD_DELETED';

-- DropIndex
DROP INDEX "AuditLog_actorId_idx";

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "changes" JSONB,
ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "entityType" TEXT,
ADD COLUMN     "previousVersionId" UUID,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "siteId" UUID,
ADD COLUMN     "versionId" UUID,
ADD COLUMN     "via" TEXT;

-- AlterTable
ALTER TABLE "EmployeeVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "JobProductVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "JobVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "MaterialVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "ProductMaterialVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "ProductVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "StationVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "ToolCavityVersion" ADD COLUMN     "createdById" UUID;

-- AlterTable
ALTER TABLE "ToolVersion" ADD COLUMN     "createdById" UUID;

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_siteId_createdAt_idx" ON "AuditLog"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");



-- The audit trail is append-only: no UPDATE, DELETE or TRUNCATE on "AuditLog",
-- whatever the application does (docs/architecture/audit.md). A maintenance
-- script that must rewrite rows sets `SET LOCAL rockware.audit_bypass = 'on'`
-- inside its own transaction; nothing in the application does.

CREATE OR REPLACE FUNCTION "audit_log_append_only"() RETURNS trigger AS $$
BEGIN
  IF current_setting('rockware.audit_bypass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'The audit trail is append-only: % on "AuditLog" is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_append_only_rows"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_append_only"();

CREATE TRIGGER "AuditLog_append_only_truncate"
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_log_append_only"();

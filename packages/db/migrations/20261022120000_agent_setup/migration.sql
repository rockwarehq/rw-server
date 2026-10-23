-- CreateEnum
CREATE TYPE "OAuthTokenKind" AS ENUM ('ACCESS', 'REFRESH');

-- CreateEnum
CREATE TYPE "SetupEntity" AS ENUM ('MATERIAL', 'PRODUCT', 'TOOL', 'JOB', 'WORKCENTER', 'STATION');

-- CreateEnum
CREATE TYPE "SetupChangesetStatus" AS ENUM ('DRAFT', 'APPLYING', 'APPLIED', 'DISCARDED', 'ROLLING_BACK', 'ROLLED_BACK');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'OAUTH_GRANT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'OAUTH_GRANT_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'AGENT_CONNECTIONS_POLICY_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'SETUP_CHANGESET_PROPOSED';
ALTER TYPE "AuditAction" ADD VALUE 'SETUP_CHANGESET_APPLIED';
ALTER TYPE "AuditAction" ADD VALUE 'SETUP_CHANGESET_DISCARDED';
ALTER TYPE "AuditAction" ADD VALUE 'SETUP_CHANGESET_ROLLED_BACK';
ALTER TYPE "AuditAction" ADD VALUE 'SETUP_CHANGESET_CLEARED';

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "agentConnections" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OAuthClient" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthGrant" (
    "id" UUID NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "userId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "siteId" UUID NOT NULL,

    CONSTRAINT "OAuthGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthCode" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantId" UUID NOT NULL,

    CONSTRAINT "OAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthToken" (
    "id" UUID NOT NULL,
    "kind" "OAuthTokenKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "rotatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantId" UUID NOT NULL,

    CONSTRAINT "OAuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalRef" (
    "id" UUID NOT NULL,
    "entityType" "SetupEntity" NOT NULL,
    "source" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "changesetId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "siteId" UUID NOT NULL,

    CONSTRAINT "ExternalRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SetupChangeset" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "SetupChangesetStatus" NOT NULL DEFAULT 'DRAFT',
    "author" "GraphChangesetAuthor" NOT NULL DEFAULT 'USER',
    "spec" JSONB,
    "planResult" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "grantId" UUID,
    "clientName" TEXT,
    "mapping" JSONB,
    "origin" JSONB,
    "createdById" UUID,
    "appliedById" UUID,
    "appliedAt" TIMESTAMPTZ(3),
    "discardedAt" TIMESTAMPTZ(3),
    "rolledBackById" UUID,
    "rolledBackAt" TIMESTAMPTZ(3),
    "clearedAt" TIMESTAMPTZ(3),
    "progress" JSONB,
    "leaseUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "siteId" UUID NOT NULL,

    CONSTRAINT "SetupChangeset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SetupChangesetRow" (
    "id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "entity" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityId" UUID,
    "matchedBy" TEXT,
    "changes" JSONB NOT NULL,
    "links" JSONB,
    "issues" JSONB NOT NULL,
    "origin" JSONB,
    "changesetId" UUID NOT NULL,

    CONSTRAINT "SetupChangesetRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SetupUpload" (
    "id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3),
    "size" INTEGER,
    "data" BYTEA,
    "grantId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "siteId" UUID NOT NULL,

    CONSTRAINT "SetupUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SetupChangesetWrite" (
    "id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "entity" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "materialId" UUID,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "before" JSONB,
    "beforeVersionId" UUID,
    "afterVersionId" UUID,
    "outcome" TEXT,
    "reason" TEXT,
    "changesetId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SetupChangesetWrite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OAuthGrant_userId_idx" ON "OAuthGrant"("userId");

-- CreateIndex
CREATE INDEX "OAuthGrant_siteId_idx" ON "OAuthGrant"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthCode_codeHash_key" ON "OAuthCode"("codeHash");

-- CreateIndex
CREATE INDEX "OAuthCode_grantId_idx" ON "OAuthCode"("grantId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthToken_tokenHash_key" ON "OAuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "OAuthToken_grantId_idx" ON "OAuthToken"("grantId");

-- CreateIndex
CREATE INDEX "ExternalRef_siteId_entityType_entityId_idx" ON "ExternalRef"("siteId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalRef_siteId_entityType_source_key_key" ON "ExternalRef"("siteId", "entityType", "source", "key");

-- CreateIndex
CREATE INDEX "SetupChangeset_siteId_status_createdAt_idx" ON "SetupChangeset"("siteId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SetupChangesetRow_changesetId_action_position_idx" ON "SetupChangesetRow"("changesetId", "action", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SetupChangesetRow_changesetId_position_key" ON "SetupChangesetRow"("changesetId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SetupUpload_tokenHash_key" ON "SetupUpload"("tokenHash");

-- CreateIndex
CREATE INDEX "SetupUpload_siteId_createdAt_idx" ON "SetupUpload"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "SetupChangesetWrite_changesetId_outcome_rank_seq_idx" ON "SetupChangesetWrite"("changesetId", "outcome", "rank", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "SetupChangesetWrite_changesetId_seq_key" ON "SetupChangesetWrite"("changesetId", "seq");

-- AddForeignKey
ALTER TABLE "OAuthGrant" ADD CONSTRAINT "OAuthGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthGrant" ADD CONSTRAINT "OAuthGrant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthGrant" ADD CONSTRAINT "OAuthGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthGrant" ADD CONSTRAINT "OAuthGrant_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthCode" ADD CONSTRAINT "OAuthCode_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "OAuthGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthToken" ADD CONSTRAINT "OAuthToken_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "OAuthGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalRef" ADD CONSTRAINT "ExternalRef_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupChangeset" ADD CONSTRAINT "SetupChangeset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupChangeset" ADD CONSTRAINT "SetupChangeset_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupChangeset" ADD CONSTRAINT "SetupChangeset_rolledBackById_fkey" FOREIGN KEY ("rolledBackById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupChangeset" ADD CONSTRAINT "SetupChangeset_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupChangesetRow" ADD CONSTRAINT "SetupChangesetRow_changesetId_fkey" FOREIGN KEY ("changesetId") REFERENCES "SetupChangeset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupUpload" ADD CONSTRAINT "SetupUpload_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupUpload" ADD CONSTRAINT "SetupUpload_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupChangesetWrite" ADD CONSTRAINT "SetupChangesetWrite_changesetId_fkey" FOREIGN KEY ("changesetId") REFERENCES "SetupChangeset"("id") ON DELETE CASCADE ON UPDATE CASCADE;


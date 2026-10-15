-- Graph changesets (proposed graph creations a person approves and applies
-- in one transaction) and the agent runtime: definitions, triggers,
-- sessions with a durable event log, inputs, model history, and permission
-- requests and saved rules.

-- CreateEnum
CREATE TYPE "AgentTriggerKind" AS ENUM ('HOOK_EVENT', 'SCHEDULE');

-- CreateEnum
CREATE TYPE "AgentSessionTrigger" AS ENUM ('CHAT', 'HOOK_EVENT', 'SCHEDULE', 'AGENT');

-- CreateEnum
CREATE TYPE "AgentSessionStatus" AS ENUM ('IDLE', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'FAILED');

-- CreateEnum
CREATE TYPE "AgentInputStatus" AS ENUM ('ADMITTED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "AgentMessageRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "AgentPermissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "GraphChangesetStatus" AS ENUM ('DRAFT', 'APPLIED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "GraphChangesetAuthor" AS ENUM ('USER', 'AGENT');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'GRAPH_CHANGESET_APPLIED';

-- CreateTable
CREATE TABLE "AgentDefinition" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "baseKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "instructions" TEXT,
    "model" TEXT,
    "effort" TEXT,
    "maxSteps" INTEGER,
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "notificationGroupId" UUID,
    "runAsUserId" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AgentDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTrigger" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "agentKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "kind" "AgentTriggerKind" NOT NULL,
    "prompt" JSONB NOT NULL,
    "eventNamespace" TEXT,
    "eventName" TEXT,
    "eventVersion" TEXT,
    "hookId" UUID,
    "schedule" JSONB,
    "cooldownMs" INTEGER NOT NULL DEFAULT 0,
    "maxRunsPerHour" INTEGER NOT NULL DEFAULT 6,
    "lastFiredAt" TIMESTAMPTZ(3),
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AgentTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "agentKey" TEXT NOT NULL,
    "agentVersion" INTEGER NOT NULL DEFAULT 0,
    "parentSessionId" UUID,
    "trigger" "AgentSessionTrigger" NOT NULL DEFAULT 'CHAT',
    "triggerRef" TEXT,
    "actorUserId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" "AgentSessionStatus" NOT NULL DEFAULT 'IDLE',
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "usage" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEvent" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentInput" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '[]',
    "status" "AgentInputStatus" NOT NULL DEFAULT 'ADMITTED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" "AgentMessageRole" NOT NULL,
    "content" JSONB NOT NULL,
    "usage" JSONB,
    "model" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPermissionRequest" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "toolUseId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolInput" JSONB NOT NULL,
    "permission" TEXT NOT NULL,
    "patterns" TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" "AgentPermissionStatus" NOT NULL DEFAULT 'PENDING',
    "reply" TEXT,
    "feedback" TEXT,
    "repliedById" UUID,
    "repliedAt" TIMESTAMPTZ(3),
    "notifiedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentPermissionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPermissionRule" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "agentKey" TEXT,
    "permission" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentPermissionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphChangeset" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT,
    "status" "GraphChangesetStatus" NOT NULL DEFAULT 'DRAFT',
    "author" "GraphChangesetAuthor" NOT NULL DEFAULT 'USER',
    "spec" JSONB NOT NULL,
    "planResult" JSONB NOT NULL,
    "graphVersion" JSONB NOT NULL,
    "sessionId" UUID,
    "createdById" UUID,
    "appliedById" UUID,
    "appliedAt" TIMESTAMPTZ(3),
    "appliedResult" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphChangeset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentDefinition_siteId_key_key" ON "AgentDefinition"("siteId", "key");

-- CreateIndex
CREATE INDEX "AgentTrigger_siteId_kind_enabled_idx" ON "AgentTrigger"("siteId", "kind", "enabled");

-- CreateIndex
CREATE INDEX "AgentTrigger_siteId_eventNamespace_eventName_eventVersion_e_idx" ON "AgentTrigger"("siteId", "eventNamespace", "eventName", "eventVersion", "enabled");

-- CreateIndex
CREATE INDEX "AgentSession_siteId_actorUserId_updatedAt_idx" ON "AgentSession"("siteId", "actorUserId", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentSession_siteId_status_idx" ON "AgentSession"("siteId", "status");

-- CreateIndex
CREATE INDEX "AgentSession_parentSessionId_idx" ON "AgentSession"("parentSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSession_siteId_triggerRef_key" ON "AgentSession"("siteId", "triggerRef");

-- CreateIndex
CREATE UNIQUE INDEX "AgentEvent_sessionId_seq_key" ON "AgentEvent"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "AgentInput_sessionId_status_createdAt_idx" ON "AgentInput"("sessionId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentMessage_sessionId_seq_key" ON "AgentMessage"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "AgentPermissionRequest_siteId_status_createdAt_idx" ON "AgentPermissionRequest"("siteId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPermissionRequest_sessionId_toolUseId_key" ON "AgentPermissionRequest"("sessionId", "toolUseId");

-- CreateIndex
CREATE INDEX "AgentPermissionRule_siteId_permission_idx" ON "AgentPermissionRule"("siteId", "permission");

-- CreateIndex
CREATE INDEX "GraphChangeset_siteId_status_createdAt_idx" ON "GraphChangeset"("siteId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "GraphChangeset_sessionId_idx" ON "GraphChangeset"("sessionId");

-- AddForeignKey
ALTER TABLE "AgentDefinition" ADD CONSTRAINT "AgentDefinition_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTrigger" ADD CONSTRAINT "AgentTrigger_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentInput" ADD CONSTRAINT "AgentInput_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPermissionRequest" ADD CONSTRAINT "AgentPermissionRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPermissionRule" ADD CONSTRAINT "AgentPermissionRule_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphChangeset" ADD CONSTRAINT "GraphChangeset_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphChangeset" ADD CONSTRAINT "GraphChangeset_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;


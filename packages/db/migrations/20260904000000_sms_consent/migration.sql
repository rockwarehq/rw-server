-- CreateEnum
CREATE TYPE "SmsConsentStatus" AS ENUM ('OPTED_IN', 'OPTED_OUT');

-- CreateEnum
CREATE TYPE "SmsConsentMethod" AS ENUM ('WEB_FORM', 'VERBAL', 'PAPER', 'TEXT_KEYWORD', 'STOP_KEYWORD', 'IMPORTED');

-- CreateTable
CREATE TABLE "SmsConsent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "status" "SmsConsentStatus" NOT NULL,
    "method" "SmsConsentMethod" NOT NULL,
    "statusAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SmsConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsConsentEvent" (
    "id" UUID NOT NULL,
    "consentId" UUID NOT NULL,
    "status" "SmsConsentStatus" NOT NULL,
    "method" "SmsConsentMethod" NOT NULL,
    "source" "ActionSource" NOT NULL DEFAULT 'MANUAL',
    "actorUserId" UUID,
    "note" TEXT,
    "relayEventId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubCursor" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "cursor" TEXT NOT NULL DEFAULT '0',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "HubCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmsConsent_workspaceId_status_idx" ON "SmsConsent"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SmsConsent_workspaceId_phone_key" ON "SmsConsent"("workspaceId", "phone");

-- CreateIndex
CREATE INDEX "SmsConsentEvent_consentId_createdAt_idx" ON "SmsConsentEvent"("consentId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SmsConsentEvent_consentId_relayEventId_key" ON "SmsConsentEvent"("consentId", "relayEventId");

-- AddForeignKey
ALTER TABLE "SmsConsent" ADD CONSTRAINT "SmsConsent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsConsentEvent" ADD CONSTRAINT "SmsConsentEvent_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "SmsConsent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsConsentEvent" ADD CONSTRAINT "SmsConsentEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

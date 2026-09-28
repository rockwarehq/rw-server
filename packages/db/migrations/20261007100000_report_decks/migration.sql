-- Report decks (ADR-0018): decks, their editions, and links that open editions without signing in.
-- CreateEnum
CREATE TYPE "ReportDeckVisibility" AS ENUM ('SITE', 'PRIVATE');

-- CreateEnum
CREATE TYPE "ReportDeckEditionSource" AS ENUM ('MANUAL', 'SCHEDULE');

-- CreateTable
CREATE TABLE "ReportDeck" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workcenterId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "range" TEXT NOT NULL,
    "slides" JSONB NOT NULL DEFAULT '[]',
    "visibility" "ReportDeckVisibility" NOT NULL DEFAULT 'SITE',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ReportDeck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportDeckEdition" (
    "id" UUID NOT NULL,
    "deckId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "asOf" TIMESTAMPTZ(3) NOT NULL,
    "dateFrom" DATE,
    "dateTo" DATE,
    "source" "ReportDeckEditionSource" NOT NULL,
    "automationId" UUID,
    "createdById" UUID,
    "setup" JSONB NOT NULL,
    "pages" JSONB NOT NULL,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportDeckEdition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportDeckLink" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "automationId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportDeckLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportDeckLinkEdition" (
    "linkId" UUID NOT NULL,
    "editionId" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ReportDeckLinkEdition_pkey" PRIMARY KEY ("linkId","editionId")
);

-- CreateIndex
CREATE INDEX "ReportDeck_siteId_idx" ON "ReportDeck"("siteId");

-- CreateIndex
CREATE INDEX "ReportDeck_workcenterId_idx" ON "ReportDeck"("workcenterId");

-- CreateIndex
CREATE INDEX "ReportDeckEdition_deckId_asOf_idx" ON "ReportDeckEdition"("deckId", "asOf");

-- CreateIndex
CREATE INDEX "ReportDeckEdition_siteId_idx" ON "ReportDeckEdition"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportDeckLink_tokenHash_key" ON "ReportDeckLink"("tokenHash");

-- CreateIndex
CREATE INDEX "ReportDeckLink_siteId_idx" ON "ReportDeckLink"("siteId");

-- CreateIndex
CREATE INDEX "ReportDeckLinkEdition_editionId_idx" ON "ReportDeckLinkEdition"("editionId");

-- AddForeignKey
ALTER TABLE "ReportDeck" ADD CONSTRAINT "ReportDeck_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportDeck" ADD CONSTRAINT "ReportDeck_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportDeckEdition" ADD CONSTRAINT "ReportDeckEdition_deckId_fkey" FOREIGN KEY ("deckId") REFERENCES "ReportDeck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportDeckLinkEdition" ADD CONSTRAINT "ReportDeckLinkEdition_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "ReportDeckLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportDeckLinkEdition" ADD CONSTRAINT "ReportDeckLinkEdition_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "ReportDeckEdition"("id") ON DELETE CASCADE ON UPDATE CASCADE;


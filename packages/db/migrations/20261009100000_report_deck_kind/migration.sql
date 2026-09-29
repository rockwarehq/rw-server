-- Report deck kinds: a SHIFT_RECAP deck is one workcenter's latest shift recap
-- for one shift name, sent from the recap page (ADR-0018). Existing decks are DECKs.
-- CreateEnum
CREATE TYPE "ReportDeckKind" AS ENUM ('DECK', 'SHIFT_RECAP');

-- AlterTable
ALTER TABLE "ReportDeck" ADD COLUMN "kind" "ReportDeckKind" NOT NULL DEFAULT 'DECK';

-- Decks are listed by site and kind.
DROP INDEX "ReportDeck_siteId_idx";
CREATE INDEX "ReportDeck_siteId_kind_idx" ON "ReportDeck"("siteId", "kind");

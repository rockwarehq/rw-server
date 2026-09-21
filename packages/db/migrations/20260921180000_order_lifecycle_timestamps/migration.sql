-- Order lifecycle timestamps.
--
-- Until now the only dates an order carried were createdAt and updatedAt, so
-- "when was this completed?" had to be answered with updatedAt — correct in
-- practice, because COMPLETED and CANCELLED are terminal and their line items
-- stop being editable, but it drifts the moment anything else writes the row.
-- These columns record the moves themselves.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "openedAt" TIMESTAMPTZ(3);
ALTER TABLE "Order" ADD COLUMN "completedAt" TIMESTAMPTZ(3);
ALTER TABLE "Order" ADD COLUMN "cancelledAt" TIMESTAMPTZ(3);
ALTER TABLE "Order" ADD COLUMN "createdByUserId" UUID;

-- Backfill, best effort and deliberately conservative.
--
-- completedAt / cancelledAt take updatedAt, which for a terminal order IS the
-- moment it closed: nothing in the product can write the row afterwards (no
-- outbound transitions, no line edits). For a COMPLETED order the consumption
-- ledger is the stronger witness, so prefer it where one exists.
UPDATE "Order" o
SET "completedAt" = COALESCE(
  (SELECT MIN(c."createdAt") FROM "OrderConsumption" c WHERE c."orderId" = o."id"),
  o."updatedAt"
)
WHERE o."status" = 'COMPLETED' AND o."completedAt" IS NULL;

UPDATE "Order"
SET "cancelledAt" = "updatedAt"
WHERE "status" = 'CANCELLED' AND "cancelledAt" IS NULL;

-- openedAt is the one we cannot recover: an order drafted on Monday and
-- opened on Friday left no trace of Friday. createdAt is exact for anything
-- created straight to OPEN (the common path) and early for the rest, which is
-- the same approximation the UI was already making, now frozen once instead
-- of recomputed from a drifting updatedAt.
UPDATE "Order"
SET "openedAt" = "createdAt"
WHERE "status" <> 'DRAFT' AND "openedAt" IS NULL;

-- Sorting a closed list by when things closed.
CREATE INDEX "Order_siteId_completedAt_idx" ON "Order"("siteId", "completedAt");

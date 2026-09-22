-- The order lifecycle: one live status, and dates that record the moves.
--
-- An order is raised OPEN and either COMPLETED — consuming covered stock and
-- writing the OrderConsumption ledger — or CANCELLED, closing without
-- consuming. DRAFT, IN_PROGRESS and ON_HOLD were the vocabulary of the retired
-- automatic allocation engine: DRAFT existed so an order could be staged
-- before allocation claimed stock for it, and nothing has claimed stock at
-- creation since the inventory-first cutover.
--
-- Before this, the only dates an order carried were createdAt and updatedAt,
-- so "when was this completed?" had to be answered with updatedAt — correct in
-- practice, because terminal orders stop being writable, but it drifts the
-- moment anything else touches the row.
--
-- This also drops the frozen columns and the allocation ledger that the
-- cutover left behind.

-- ── 1. The lifecycle stamps ────────────────────────────────────────────────
ALTER TABLE "Order" ADD COLUMN "openedAt" TIMESTAMPTZ(3);
ALTER TABLE "Order" ADD COLUMN "completedAt" TIMESTAMPTZ(3);
ALTER TABLE "Order" ADD COLUMN "cancelledAt" TIMESTAMPTZ(3);
ALTER TABLE "Order" ADD COLUMN "createdByUserId" UUID;

-- Terminal stamps take updatedAt, which for a terminal order IS the moment it
-- closed: nothing in the product can write the row afterwards. For a COMPLETED
-- order the consumption ledger is the stronger witness, so prefer it.
UPDATE "Order" o
SET "completedAt" = COALESCE(
  (SELECT MIN(c."createdAt") FROM "OrderConsumption" c WHERE c."orderId" = o."id"),
  o."updatedAt"
)
WHERE o."status" = 'COMPLETED' AND o."completedAt" IS NULL;

UPDATE "Order"
SET "cancelledAt" = "updatedAt"
WHERE "status" = 'CANCELLED' AND "cancelledAt" IS NULL;

-- openedAt is the one value that cannot be recovered: an order drafted on
-- Monday and opened on Friday left no trace of Friday. createdAt is exact for
-- anything created straight to OPEN — the common path, and the only path from
-- here on — and early for the rest.
UPDATE "Order" SET "openedAt" = "createdAt" WHERE "openedAt" IS NULL;

-- ── 2. Promote every non-terminal order to OPEN, before the enum narrows ───
-- A draft is work someone started; an in-progress or held order is work
-- already real. All three become OPEN rather than being discarded.
UPDATE "Order" SET "status" = 'OPEN' WHERE "status" IN ('DRAFT', 'IN_PROGRESS', 'ON_HOLD');

-- ── 3. Give the promoted rows a queue position ─────────────────────────────
-- Only DRAFT orders can lack one (sequence was assigned on the move to OPEN),
-- and they go to the back of their site's queue in a stable order rather than
-- all colliding on max+1.
WITH ranked AS (
  SELECT o."id",
         COALESCE(m."maxSeq", 0) + ROW_NUMBER() OVER (
           PARTITION BY o."siteId" ORDER BY o."createdAt", o."id"
         ) AS "nextSeq"
  FROM "Order" o
  LEFT JOIN (
    SELECT "siteId", MAX("sequence") AS "maxSeq"
    FROM "Order"
    WHERE "deletedAt" IS NULL
    GROUP BY "siteId"
  ) m ON m."siteId" = o."siteId"
  WHERE o."status" = 'OPEN' AND o."sequence" IS NULL AND o."deletedAt" IS NULL
)
UPDATE "Order" o
SET "sequence" = ranked."nextSeq"
FROM ranked
WHERE o."id" = ranked."id";

-- ── 4. The retired allocation engine's ledger ──────────────────────────────
-- Frozen since the inventory-first cutover, which backfilled its contents into
-- OrderConsumption as BACKFILL rows; that record survives this drop.
DROP TABLE IF EXISTS "OrderInventoryAllocation";

-- ── 5. The frozen columns ──────────────────────────────────────────────────
-- previousStatus served only the ON_HOLD resume path and was written but never
-- read. priority was accepted-and-ignored by the API. The three line-item
-- columns are the legacy allocation counters; fulfillment is computed coverage
-- plus OrderConsumption. previousStatus must go before step 6: it is the only
-- other column typed OrderStatus.
ALTER TABLE "Order" DROP COLUMN "previousStatus";
ALTER TABLE "Order" DROP COLUMN "priority";
ALTER TABLE "OrderLineItem" DROP COLUMN "completedQuantity";
ALTER TABLE "OrderLineItem" DROP COLUMN "scrapQuantity";
ALTER TABLE "OrderLineItem" DROP COLUMN "status";

-- ── 6. Narrow OrderStatus ──────────────────────────────────────────────────
-- Postgres cannot remove a value from an enum in place, so the type is
-- rebuilt. "Order"."status" is now its only user.
ALTER TABLE "Order" ALTER COLUMN "status" DROP DEFAULT;
CREATE TYPE "OrderStatus_new" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');
ALTER TABLE "Order"
  ALTER COLUMN "status" TYPE "OrderStatus_new"
  USING ("status"::text::"OrderStatus_new");
DROP TYPE "OrderStatus";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'OPEN';

-- ── 7. LineItemStatus had exactly one user, dropped in step 5 ──────────────
DROP TYPE "LineItemStatus";

-- ── 8. Sorting a closed list by when things closed ─────────────────────────
CREATE INDEX "Order_siteId_completedAt_idx" ON "Order"("siteId", "completedAt");

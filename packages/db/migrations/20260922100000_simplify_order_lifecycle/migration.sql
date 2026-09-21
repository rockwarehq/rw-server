-- Simplify the order lifecycle for production release.
--
-- An order is raised OPEN and either COMPLETED — consuming covered stock and
-- writing the OrderConsumption ledger — or CANCELLED, closing without
-- consuming. DRAFT, IN_PROGRESS and ON_HOLD were the vocabulary of the retired
-- automatic allocation engine: DRAFT existed so an order could be staged
-- before allocation claimed stock for it, and nothing has claimed stock at
-- creation since the inventory-first cutover. This migration also drops the
-- frozen columns and the allocation ledger that cutover left behind.

-- ── 1. Promote every non-terminal order to OPEN, before the enum narrows ────
-- A draft is work someone started; an in-progress or held order is work
-- already real. All three become OPEN rather than being discarded.
UPDATE "Order"
SET "status" = 'OPEN',
    "openedAt" = COALESCE("openedAt", "createdAt")
WHERE "status" IN ('DRAFT', 'IN_PROGRESS', 'ON_HOLD');

-- ── 2. Give the promoted rows a queue position ─────────────────────────────
-- Only DRAFT orders can lack one (sequence is assigned on the move to OPEN),
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

-- ── 3. The retired allocation engine's ledger ──────────────────────────────
-- Frozen since the inventory-first cutover, which backfilled its contents into
-- OrderConsumption as BACKFILL rows; that record survives this drop.
DROP TABLE IF EXISTS "OrderInventoryAllocation";

-- ── 4. The frozen columns ──────────────────────────────────────────────────
-- previousStatus served only the ON_HOLD resume path and is written-but-never-
-- read. priority was accepted-and-ignored by the API. The three line-item
-- columns are the legacy allocation counters; fulfillment is computed coverage
-- plus OrderConsumption. previousStatus must go before step 5: it is the only
-- other column typed OrderStatus.
ALTER TABLE "Order" DROP COLUMN "previousStatus";
ALTER TABLE "Order" DROP COLUMN "priority";
ALTER TABLE "OrderLineItem" DROP COLUMN "completedQuantity";
ALTER TABLE "OrderLineItem" DROP COLUMN "scrapQuantity";
ALTER TABLE "OrderLineItem" DROP COLUMN "status";

-- ── 5. Narrow OrderStatus ──────────────────────────────────────────────────
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

-- ── 6. LineItemStatus had exactly one user, dropped in step 4 ──────────────
DROP TYPE "LineItemStatus";

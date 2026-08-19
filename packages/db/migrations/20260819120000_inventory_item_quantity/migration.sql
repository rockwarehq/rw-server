-- InventoryItem.quantity: measured quantity per item (default 1 = discrete piece).
-- InventoryItem.quantityUnit: unit placeholder, blank until a unit source is decided.
ALTER TABLE "InventoryItem"
  ADD COLUMN "quantity" DECIMAL(18,4) NOT NULL DEFAULT 1,
  ADD COLUMN "quantityUnit" TEXT NOT NULL DEFAULT '';

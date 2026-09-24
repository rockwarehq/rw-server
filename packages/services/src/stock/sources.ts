import { Prisma, type StockSourceType } from "@rw/db";

// ============================================================================
// Stock sources — how each kind of record turns into a stock book row
// ============================================================================
//
// Every stock movement is built straight from the record that caused it, in
// SQL, so live saves, the repair job and the first fill all agree. Each
// builder only returns rows for records that still count (not deleted, not
// zero). The key stops one record from being counted twice: it is the source
// name and id, plus how many times that record's movement was cancelled, so a
// corrected record gets a fresh key.

/** The source types parts use today (ADR-0016 phase 1). */
export type ProductSourceType = Extract<
  StockSourceType,
  "INVENTORY_ITEM" | "ITEM_DISPOSITION_LOG" | "ORDER_CONSUMPTION" | "PRODUCT_STOCK_ADJUSTMENT"
>;

export const PRODUCT_SOURCE_TYPES: readonly ProductSourceType[] = [
  "INVENTORY_ITEM",
  "ITEM_DISPOSITION_LOG",
  "ORDER_CONSUMPTION",
  "PRODUCT_STOCK_ADJUSTMENT",
];

/** Column list shared by every insert into "StockMovement" built here. */
export const MOVEMENT_COLUMNS = Prisma.raw(
  `"id", "stockItemId", "siteId", "kind", "quantity", "unit", "sourceType", "sourceId", "idempotencyKey",
   "stationId", "shiftInstanceId", "isScheduled", "businessDate", "performedByUserId", "occurredAt", "createdAt"`,
);

/** "TYPE:id", or "TYPE:id:rN" once the record's movement has been cancelled N times. */
function keyFor(type: ProductSourceType, idColumn: string) {
  return Prisma.raw(
    `'${type}:' || ${idColumn} || COALESCE(':r' || NULLIF((
       SELECT COUNT(*) FROM "StockMovement" x
       WHERE x."sourceType" = '${type}' AND x."sourceId" = ${idColumn} AND x."reversesMovementId" IS NOT NULL
     ), 0)::text, '')`,
  );
}

/**
 * SELECT the movement rows for these records, in MOVEMENT_COLUMNS order.
 * Records whose product has no StockItem yet are skipped — call
 * ensureProductStockItems first.
 */
export function movementSelect(type: ProductSourceType, ids: string[]): Prisma.Sql {
  switch (type) {
    case "INVENTORY_ITEM":
      // A made part. Older rows may lack the copied site and station, so the
      // cycle fills them in.
      return Prisma.sql`
        SELECT gen_random_uuid(), si.id, COALESCE(ii."siteId", cy."siteId"), 'OUTPUT'::"StockMovementKind",
               ii.quantity, ii."quantityUnit", 'INVENTORY_ITEM'::"StockSourceType", ii.id, ${keyFor(type, "ii.id")},
               COALESCE(ii."stationId", cy."stationId"), ii."shiftInstanceId", ii."isScheduled", ii."businessDate",
               NULL::uuid, ii."createdAt", NOW()
        FROM "InventoryItem" ii
        JOIN "Cycle" cy ON cy.id = ii."cycleId"
        JOIN "ProductVersion" pv ON pv.id = ii."productVersionId"
        JOIN "StockItem" si ON si."stockableType" = 'PRODUCT' AND si."stockableId" = pv."productId"
        WHERE ii.id = ANY(${ids}::uuid[]) AND ii."deletedAt" IS NULL AND ii.quantity <> 0`;
    case "ITEM_DISPOSITION_LOG":
      return Prisma.sql`
        SELECT gen_random_uuid(), si.id, idl."siteId", 'SCRAP'::"StockMovementKind",
               -idl.quantity, si."baseUnit", 'ITEM_DISPOSITION_LOG'::"StockSourceType", idl.id, ${keyFor(type, "idl.id")},
               idl."stationId", idl."shiftInstanceId", idl."isScheduled", idl."businessDate",
               NULL::uuid, idl."createdAt", NOW()
        FROM "ItemDispositionLog" idl
        JOIN "ProductVersion" pv ON pv.id = idl."productVersionId"
        JOIN "StockItem" si ON si."stockableType" = 'PRODUCT' AND si."stockableId" = pv."productId"
        WHERE idl.id = ANY(${ids}::uuid[]) AND idl."deletedAt" IS NULL AND idl.quantity <> 0`;
    case "ORDER_CONSUMPTION":
      return Prisma.sql`
        SELECT gen_random_uuid(), si.id, oc."siteId", 'FULFILLMENT'::"StockMovementKind",
               -oc.quantity, si."baseUnit", 'ORDER_CONSUMPTION'::"StockSourceType", oc.id, ${keyFor(type, "oc.id")},
               NULL::uuid, oc."shiftInstanceId", oc."isScheduled", oc."businessDate",
               u.id, oc."createdAt", NOW()
        FROM "OrderConsumption" oc
        JOIN "StockItem" si ON si."stockableType" = 'PRODUCT' AND si."stockableId" = oc."productId"
        -- createdByUserId has no link to User; keep it only when the user still exists.
        LEFT JOIN "User" u ON u.id = oc."createdByUserId"
        WHERE oc.id = ANY(${ids}::uuid[]) AND oc.quantity <> 0`;
    case "PRODUCT_STOCK_ADJUSTMENT":
      // A count that matched (zero change) stays on the adjustment record only.
      return Prisma.sql`
        SELECT gen_random_uuid(), si.id, sa."siteId", 'ADJUSTMENT'::"StockMovementKind",
               sa.delta, si."baseUnit", 'PRODUCT_STOCK_ADJUSTMENT'::"StockSourceType", sa.id, ${keyFor(type, "sa.id")},
               NULL::uuid, sa."shiftInstanceId", sa."isScheduled", sa."businessDate",
               sa."performedByUserId", sa."createdAt", NOW()
        FROM "ProductStockAdjustment" sa
        JOIN "StockItem" si ON si."stockableType" = 'PRODUCT' AND si."stockableId" = sa."productId"
        WHERE sa.id = ANY(${ids}::uuid[]) AND sa.delta <> 0`;
  }
}

/** SELECT the product ids these records touch (deleted records included). */
export function productIdsSelect(type: ProductSourceType, ids: string[]): Prisma.Sql {
  switch (type) {
    case "INVENTORY_ITEM":
      return Prisma.sql`SELECT pv."productId" FROM "InventoryItem" ii
        JOIN "ProductVersion" pv ON pv.id = ii."productVersionId" WHERE ii.id = ANY(${ids}::uuid[])`;
    case "ITEM_DISPOSITION_LOG":
      return Prisma.sql`SELECT pv."productId" FROM "ItemDispositionLog" idl
        JOIN "ProductVersion" pv ON pv.id = idl."productVersionId" WHERE idl.id = ANY(${ids}::uuid[])`;
    case "ORDER_CONSUMPTION":
      return Prisma.sql`SELECT "productId" FROM "OrderConsumption" WHERE id = ANY(${ids}::uuid[])`;
    case "PRODUCT_STOCK_ADJUSTMENT":
      return Prisma.sql`SELECT "productId" FROM "ProductStockAdjustment" WHERE id = ANY(${ids}::uuid[])`;
  }
}

/**
 * For the repair job: SELECT (id, expected) for every record of this type,
 * where `expected` is what the record should add to stock right now — zero
 * once it is deleted. Optionally narrowed to one site.
 */
export function expectedSelect(type: ProductSourceType, siteId: string | null): Prisma.Sql {
  switch (type) {
    case "INVENTORY_ITEM":
      return Prisma.sql`
        SELECT ii.id, CASE WHEN ii."deletedAt" IS NULL THEN ii.quantity ELSE 0 END AS expected
        FROM "InventoryItem" ii JOIN "Cycle" cy ON cy.id = ii."cycleId"
        WHERE (${siteId}::uuid IS NULL OR cy."siteId" = ${siteId}::uuid)`;
    case "ITEM_DISPOSITION_LOG":
      return Prisma.sql`
        SELECT id, CASE WHEN "deletedAt" IS NULL THEN -quantity ELSE 0 END AS expected
        FROM "ItemDispositionLog" WHERE (${siteId}::uuid IS NULL OR "siteId" = ${siteId}::uuid)`;
    case "ORDER_CONSUMPTION":
      return Prisma.sql`
        SELECT id, -quantity AS expected
        FROM "OrderConsumption" WHERE (${siteId}::uuid IS NULL OR "siteId" = ${siteId}::uuid)`;
    case "PRODUCT_STOCK_ADJUSTMENT":
      return Prisma.sql`
        SELECT id, delta AS expected
        FROM "ProductStockAdjustment" WHERE (${siteId}::uuid IS NULL OR "siteId" = ${siteId}::uuid)`;
  }
}

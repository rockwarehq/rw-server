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

/** The source type materials use (ADR-0016 phase 2): every material ledger row. */
export type MaterialSourceType = Extract<StockSourceType, "MATERIAL_LEDGER_ENTRY">;

export const MATERIAL_SOURCE_TYPES: readonly MaterialSourceType[] = ["MATERIAL_LEDGER_ENTRY"];

/** Every source type that posts to the stock book today. */
export type BookSourceType = ProductSourceType | MaterialSourceType;

export const BOOK_SOURCE_TYPES: readonly BookSourceType[] = [...PRODUCT_SOURCE_TYPES, ...MATERIAL_SOURCE_TYPES];

export const isMaterialSource = (type: BookSourceType): type is MaterialSourceType => type === "MATERIAL_LEDGER_ENTRY";

/**
 * SQL test for a material ledger row (alias `a`) written *for* a shift rather
 * than at a moment: the end-of-shift PRODUCTION row, and the ADJUSTMENT a job
 * history amendment writes for a shift it corrected (its reference is the
 * amendment's id). Such rows belong to their shift no matter when they were
 * written, so shift amendments never move them to another shift; they only
 * refresh their labels from their own shift.
 */
export function shiftBoundLedger(a: string): string {
  return `(${a}."kind" = 'PRODUCTION' OR (${a}."kind" = 'ADJUSTMENT' AND ${a}."reference" IN (SELECT ja.id::text FROM "JobHistoryAmendment" ja)))`;
}

/** The same test for a stock movement (alias `a`): its source is a shift-bound ledger row. */
export function shiftBoundMovement(a: string): string {
  return `(${a}."sourceType" = 'MATERIAL_LEDGER_ENTRY' AND ${a}."sourceId" IN (SELECT sb.id FROM "MaterialLedgerEntry" sb WHERE ${shiftBoundLedger("sb")}))`;
}

/** Column list shared by every insert into "StockMovement" built here. */
export const MOVEMENT_COLUMNS = Prisma.raw(
  `"id", "stockItemId", "siteId", "kind", "quantity", "unit", "sourceType", "sourceId", "idempotencyKey",
   "stationId", "shiftInstanceId", "isScheduled", "businessDate", "performedByUserId", "occurredAt", "createdAt",
   "note"`,
);

/** "TYPE:id", or "TYPE:id:rN" once the record's movement has been cancelled N times. */
function keyFor(type: BookSourceType, idColumn: string) {
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
export function movementSelect(type: BookSourceType, ids: string[]): Prisma.Sql {
  switch (type) {
    case "INVENTORY_ITEM":
      // A made part. Older rows may lack the copied site and station, so the
      // cycle fills them in.
      return Prisma.sql`
        SELECT gen_random_uuid(), si.id, COALESCE(ii."siteId", cy."siteId"), 'OUTPUT'::"StockMovementKind",
               ii.quantity, ii."quantityUnit", 'INVENTORY_ITEM'::"StockSourceType", ii.id, ${keyFor(type, "ii.id")},
               COALESCE(ii."stationId", cy."stationId"), ii."shiftInstanceId", ii."isScheduled", ii."businessDate",
               NULL::uuid, ii."createdAt", NOW(), NULL::text
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
               NULL::uuid, idl."createdAt", NOW(), NULL::text
        FROM "ItemDispositionLog" idl
        JOIN "ProductVersion" pv ON pv.id = idl."productVersionId"
        JOIN "StockItem" si ON si."stockableType" = 'PRODUCT' AND si."stockableId" = pv."productId"
        WHERE idl.id = ANY(${ids}::uuid[]) AND idl."deletedAt" IS NULL AND idl.quantity <> 0`;
    case "ORDER_CONSUMPTION":
      return Prisma.sql`
        SELECT gen_random_uuid(), si.id, oc."siteId", 'FULFILLMENT'::"StockMovementKind",
               -oc.quantity, si."baseUnit", 'ORDER_CONSUMPTION'::"StockSourceType", oc.id, ${keyFor(type, "oc.id")},
               NULL::uuid, oc."shiftInstanceId", oc."isScheduled", oc."businessDate",
               u.id, oc."createdAt", NOW(), NULL::text
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
               sa."performedByUserId", sa."createdAt", NOW(), NULL::text
        FROM "ProductStockAdjustment" sa
        JOIN "StockItem" si ON si."stockableType" = 'PRODUCT' AND si."stockableId" = sa."productId"
        WHERE sa.id = ANY(${ids}::uuid[]) AND sa.delta <> 0`;
    case "MATERIAL_LEDGER_ENTRY":
      // A material ledger row, in the unit it was written in (the totals
      // convert it). The end-of-shift PRODUCTION row becomes USAGE. Rows
      // written for a shift (shiftBoundLedger) are placed at its start.
      return Prisma.sql`
        SELECT gen_random_uuid(), si.id, le."siteId",
               (CASE le.kind WHEN 'PRODUCTION' THEN 'USAGE' ELSE le.kind::text END)::"StockMovementKind",
               le.quantity, le.unit::text, 'MATERIAL_LEDGER_ENTRY'::"StockSourceType", le.id, ${keyFor(type, "le.id")},
               NULL::uuid, le."shiftInstanceId", le."isScheduled", le."businessDate",
               le."performedByUserId",
               CASE WHEN ${Prisma.raw(shiftBoundLedger("le"))} THEN COALESCE(sh."startTime", le."createdAt")
                    ELSE le."createdAt" END,
               NOW(), le.note
        FROM "MaterialLedgerEntry" le
        JOIN "StockItem" si ON si."stockableType" = 'MATERIAL' AND si."stockableId" = le."materialId"
        LEFT JOIN "ShiftInstance" sh ON sh.id = le."shiftInstanceId"
        WHERE le.id = ANY(${ids}::uuid[]) AND le.quantity <> 0`;
  }
}

/** SELECT the material ids these ledger rows are for. */
export function materialIdsSelect(ids: string[]): Prisma.Sql {
  return Prisma.sql`SELECT "materialId" FROM "MaterialLedgerEntry" WHERE id = ANY(${ids}::uuid[])`;
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

/** Which records the repair job looks at. Every field narrows it; none means all. */
export interface RecordScope {
  siteId?: string | null;
  /** Only records made or changed since this moment. */
  since?: Date | null;
  /** Only records for these products (part sources only). */
  productIds?: string[] | null;
}

/**
 * For the repair job: SELECT (id, expected) for the records of this type in
 * scope, where `expected` is what the record should add to stock right now —
 * zero once it is deleted.
 */
export function expectedSelect(type: BookSourceType, scope: RecordScope = {}): Prisma.Sql {
  const siteId = scope.siteId ?? null;
  const since = scope.since ?? null;
  const products = scope.productIds ?? null;
  // Parts and scrap name the product through its version; the index is on the version.
  const byVersion = (column: string) =>
    products
      ? Prisma.sql`AND ${Prisma.raw(column)} IN (SELECT id FROM "ProductVersion" WHERE "productId" = ANY(${products}::uuid[]))`
      : Prisma.empty;
  const byProduct = products ? Prisma.sql`AND "productId" = ANY(${products}::uuid[])` : Prisma.empty;
  switch (type) {
    case "INVENTORY_ITEM":
      return Prisma.sql`
        SELECT ii.id, CASE WHEN ii."deletedAt" IS NULL THEN ii.quantity ELSE 0 END AS expected
        FROM "InventoryItem" ii JOIN "Cycle" cy ON cy.id = ii."cycleId"
        WHERE (${siteId}::uuid IS NULL OR cy."siteId" = ${siteId}::uuid)
          AND (${since}::timestamptz IS NULL OR ii."updatedAt" >= ${since}::timestamptz)
          ${byVersion('ii."productVersionId"')}`;
    case "ITEM_DISPOSITION_LOG":
      return Prisma.sql`
        SELECT id, CASE WHEN "deletedAt" IS NULL THEN -quantity ELSE 0 END AS expected
        FROM "ItemDispositionLog"
        WHERE (${siteId}::uuid IS NULL OR "siteId" = ${siteId}::uuid)
          AND (${since}::timestamptz IS NULL OR "updatedAt" >= ${since}::timestamptz)
          ${byVersion('"productVersionId"')}`;
    case "ORDER_CONSUMPTION":
      // Never changed after it is written, so its creation time is enough.
      return Prisma.sql`
        SELECT id, -quantity AS expected
        FROM "OrderConsumption"
        WHERE (${siteId}::uuid IS NULL OR "siteId" = ${siteId}::uuid)
          AND (${since}::timestamptz IS NULL OR "createdAt" >= ${since}::timestamptz)
          ${byProduct}`;
    case "PRODUCT_STOCK_ADJUSTMENT":
      return Prisma.sql`
        SELECT id, delta AS expected
        FROM "ProductStockAdjustment"
        WHERE (${siteId}::uuid IS NULL OR "siteId" = ${siteId}::uuid)
          AND (${since}::timestamptz IS NULL OR "createdAt" >= ${since}::timestamptz)
          ${byProduct}`;
    case "MATERIAL_LEDGER_ENTRY":
      // Ledger rows are never changed or deleted. `productIds` does not apply.
      return Prisma.sql`
        SELECT id, quantity AS expected
        FROM "MaterialLedgerEntry"
        WHERE (${siteId}::uuid IS NULL OR "siteId" = ${siteId}::uuid)
          AND (${since}::timestamptz IS NULL OR "createdAt" >= ${since}::timestamptz)`;
  }
}

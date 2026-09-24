import prisma from "@rw/db";
import { countOffBalances, rebuildBalances, rebuildItemBalances } from "./balance.js";
import { repostSources } from "./post.js";
import {
  BOOK_SOURCE_TYPES,
  type BookSourceType,
  expectedSelect,
  PRODUCT_SOURCE_TYPES,
  type ProductSourceType,
  type RecordScope,
} from "./sources.js";

// ============================================================================
// Checking and repairing the stock book (ADR-0016)
// ============================================================================
//
// Each made part, scrap entry, order, count and material ledger row should add
// exactly its own amount to the stock book (zero once deleted). This finds records where the
// book disagrees and, when asked, fixes them the normal way: cancel what is
// there and post the right amount. Then it rebuilds the balances.
//
// It also checks the saved totals (StockBalance) against the book, and
// rebuilds them when repairing.
//
// It reports, but never fixes:
// - movements whose record is gone for good (for example, a station was
//   really deleted). The parts were still made, so their stock stays.
// - StockItems whose product or material no longer exists, and products or
//   materials with no StockItem (made by a script that skips the services).
// - Materials that are not tracked (no stock unit) but sit on the bill of
//   materials of a live part, so their production use is not being recorded.
//
// It also keeps each material's stock unit in step with its catalog unit:
// a script that edits a material in place can leave them apart. Repair sets
// the stock unit back and rebuilds that material's totals, converted.

/** Small batches keep each repair save short, so live saves are barely held up. */
const BATCH = 200;

export interface ReconcileReport {
  /** Records whose stock book total disagrees with the record, per source type. */
  mismatched: Record<BookSourceType, number>;
  /** Stock movements whose record no longer exists. */
  movementsWithoutSource: number;
  /** StockItems pointing at a product or material that does not exist. */
  stockItemsWithoutStockable: number;
  /** Products and materials with no StockItem. Products get one when they first move. */
  stockablesWithoutStockItem: number;
  /** StockBalance rows that did not match the book before any repair. */
  balancesOff: number;
  /** Not-tracked materials on the bill of materials of a live part: their use goes unrecorded. */
  untrackedMaterialsInUse: number;
  /** Materials whose stock unit differs from their catalog unit (repair re-syncs them). */
  unitsOutOfStep: number;
  /** True when the mismatches were fixed and balances rebuilt. */
  repaired: boolean;
}

async function mismatchedIds(type: BookSourceType, scope: RecordScope): Promise<string[]> {
  const narrow = !!(scope.since || scope.productIds);
  const siteId = scope.siteId ?? null;
  // A narrow check looks up each record's movements by index; a full check
  // adds up the whole book for the type once.
  const rows = narrow
    ? await prisma.$queryRaw<Array<{ id: string }>>`
        WITH facts AS (${expectedSelect(type, scope)})
        SELECT f.id FROM facts f
        LEFT JOIN LATERAL (
          SELECT SUM(m.quantity) AS net FROM "StockMovement" m
          WHERE m."sourceType" = ${type}::"StockSourceType" AND m."sourceId" = f.id
        ) b ON true
        WHERE COALESCE(b.net, 0) <> f.expected
      `
    : await prisma.$queryRaw<Array<{ id: string }>>`
        WITH facts AS (${expectedSelect(type, scope)}),
        booked AS (
          SELECT "sourceId", SUM(quantity) AS net
          FROM "StockMovement"
          WHERE "sourceType" = ${type}::"StockSourceType"
            AND (${siteId}::uuid IS NULL OR "siteId" = ${siteId}::uuid)
          GROUP BY "sourceId"
        )
        SELECT f.id FROM facts f
        LEFT JOIN booked b ON b."sourceId" = f.id
        WHERE COALESCE(b.net, 0) <> f.expected
      `;
  return rows.map((r) => r.id);
}

/** Cancel and repost these records in small saves, one ordered lock pass each. */
async function repairRecords(type: BookSourceType, ids: string[], note: string): Promise<void> {
  for (let i = 0; i < ids.length; i += BATCH) {
    const sources = [{ type, ids: ids.slice(i, i + BATCH) }];
    await prisma.$transaction((tx) => repostSources(tx, { cancel: sources, post: sources }, { note }), {
      timeout: 60_000,
    });
  }
}

/** Material StockItems whose stock unit is not the material's current catalog unit. */
async function unitsOutOfStep(siteId: string | null) {
  return prisma.$queryRaw<Array<{ id: string; unit: string }>>`
    SELECT si.id, COALESCE(mv."weightUnits"::text, '') AS unit
    FROM "StockItem" si
    JOIN "Material" m ON m.id = si."stockableId"
    LEFT JOIN "MaterialVersion" mv ON mv.id = m."currentVersionId"
    WHERE si."stockableType" = 'MATERIAL'
      AND (${siteId}::uuid IS NULL OR si."siteId" = ${siteId}::uuid)
      AND si."baseUnit" <> COALESCE(mv."weightUnits"::text, '')
    ORDER BY si.id
  `;
}

/**
 * Compare the stock book against the records it comes from, for parts and
 * materials. With `repair: true`, fix what disagrees and rebuild the balances.
 */
export async function reconcileStock(options: { siteId?: string; repair?: boolean } = {}): Promise<ReconcileReport> {
  const siteId = options.siteId ?? null;
  const mismatched = {} as Record<BookSourceType, number>;

  const drift = await unitsOutOfStep(siteId);
  if (options.repair && drift.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const { id, unit } of drift) {
        await tx.stockItem.update({ where: { id }, data: { baseUnit: unit } });
      }
      await rebuildItemBalances(
        tx,
        drift.map((d) => d.id),
      );
    });
  }

  for (const type of BOOK_SOURCE_TYPES) {
    const ids = await mismatchedIds(type, { siteId });
    mismatched[type] = ids.length;
    if (options.repair) await repairRecords(type, ids, "Stock repair");
  }

  const [{ orphans }] = await prisma.$queryRaw<Array<{ orphans: bigint }>>`
    SELECT COUNT(*) AS orphans FROM "StockMovement" m
    WHERE (${siteId}::uuid IS NULL OR m."siteId" = ${siteId}::uuid)
      AND CASE m."sourceType"
        WHEN 'INVENTORY_ITEM' THEN NOT EXISTS (SELECT 1 FROM "InventoryItem" x WHERE x.id = m."sourceId")
        WHEN 'ITEM_DISPOSITION_LOG' THEN NOT EXISTS (SELECT 1 FROM "ItemDispositionLog" x WHERE x.id = m."sourceId")
        WHEN 'ORDER_CONSUMPTION' THEN NOT EXISTS (SELECT 1 FROM "OrderConsumption" x WHERE x.id = m."sourceId")
        WHEN 'PRODUCT_STOCK_ADJUSTMENT' THEN NOT EXISTS (SELECT 1 FROM "ProductStockAdjustment" x WHERE x.id = m."sourceId")
        WHEN 'MATERIAL_LEDGER_ENTRY' THEN NOT EXISTS (SELECT 1 FROM "MaterialLedgerEntry" x WHERE x.id = m."sourceId")
        ELSE false
      END
  `;
  const [{ missing }] = await prisma.$queryRaw<Array<{ missing: bigint }>>`
    SELECT COUNT(*) AS missing FROM "StockItem" si
    WHERE (${siteId}::uuid IS NULL OR si."siteId" = ${siteId}::uuid)
      AND CASE si."stockableType"
        WHEN 'PRODUCT' THEN NOT EXISTS (SELECT 1 FROM "Product" p WHERE p.id = si."stockableId")
        WHEN 'MATERIAL' THEN NOT EXISTS (SELECT 1 FROM "Material" x WHERE x.id = si."stockableId")
      END
  `;

  const [{ unlinked }] = await prisma.$queryRaw<Array<{ unlinked: bigint }>>`
    SELECT
      (SELECT COUNT(*) FROM "Product" p
       WHERE (${siteId}::uuid IS NULL OR p."siteId" = ${siteId}::uuid)
         AND NOT EXISTS (SELECT 1 FROM "StockItem" si WHERE si."stockableType" = 'PRODUCT' AND si."stockableId" = p.id))
      +
      (SELECT COUNT(*) FROM "Material" m
       WHERE (${siteId}::uuid IS NULL OR m."siteId" = ${siteId}::uuid)
         AND NOT EXISTS (SELECT 1 FROM "StockItem" si WHERE si."stockableType" = 'MATERIAL' AND si."stockableId" = m.id))
      AS unlinked
  `;

  const [{ untracked }] = await prisma.$queryRaw<Array<{ untracked: bigint }>>`
    SELECT COUNT(DISTINCT m.id) AS untracked
    FROM "Material" m
    LEFT JOIN "MaterialVersion" mv ON mv.id = m."currentVersionId"
    JOIN "ProductMaterial" pm ON pm."materialId" = m.id AND pm."archivedAt" IS NULL
    JOIN "Product" p ON p.id = pm."productId" AND p."deletedAt" IS NULL AND p."archivedAt" IS NULL
    WHERE mv."weightUnits" IS NULL
      AND m."deletedAt" IS NULL AND m."archivedAt" IS NULL
      AND (${siteId}::uuid IS NULL OR m."siteId" = ${siteId}::uuid)
  `;

  const balancesOff = await countOffBalances({ siteId });
  if (options.repair) await rebuildBalances({ siteId });

  return {
    mismatched,
    movementsWithoutSource: Number(orphans),
    stockItemsWithoutStockable: Number(missing),
    stockablesWithoutStockItem: Number(unlinked),
    balancesOff,
    untrackedMaterialsInUse: Number(untracked),
    unitsOutOfStep: drift.length,
    repaired: options.repair === true,
  };
}

/** Kept for existing callers: the check now covers parts and materials. */
export const reconcileProductStock = reconcileStock;

/**
 * True when every record matches the book, every total matches the book, and
 * every stock unit matches its catalog unit. Not-tracked materials in use are
 * a setup gap to show people, not a fault in the book.
 */
export function isClean(report: ReconcileReport): boolean {
  return (
    Object.values(report.mismatched).every((n) => n === 0) && report.balancesOff === 0 && report.unitsOutOfStep === 0
  );
}

// ============================================================================
// Catch-up after the stock_ledger deploy
// ============================================================================
//
// While a deploy rolls out, servers still running the old code keep saving
// made parts, scrap, orders and counts, but only update the old ProductStock
// counters, not the stock book. The workers run this every few minutes after
// they start, so the gap closes by itself and nobody has to run a script.
//
// Old code updates ProductStock in the same save as every stock record, and
// new code never touches it. So a ProductStock row changed after the migration
// ran names a product an old server saved something for. Only those products'
// recent records are checked. When there are none, a pass is one tiny query.
// A day after the migration there can be no old servers left, and it stops.

/**
 * When the stock_ledger migration ran: it made a StockItem for every product
 * and material at that moment, so the oldest StockItem tells us. (The
 * migrations table itself may not be readable by the app's database user.)
 * Null when there are none, which means there was no stock to miss.
 */
export async function stockMigrationTime(): Promise<Date | null> {
  const [row] = await prisma.$queryRaw<Array<{ at: Date | null }>>`SELECT MIN("createdAt") AS at FROM "StockItem"`;
  return row?.at ?? null;
}

/** Look a little before the migration started, in case clocks disagree. */
const CATCH_UP_MARGIN_MS = 5 * 60 * 1000;
/** Old servers are long gone by then. */
const CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CatchUpResult =
  /** Not needed: there is no stock yet, or the migration ran over a day ago. */
  { status: "done" } | { status: "checked"; products: number; fixed: Record<ProductSourceType, number> };

/**
 * Post anything old servers saved during the rollout. Safe to run as often as
 * you like, and at the same time as live saves. `after` skips products whose
 * ProductStock row has not changed since then (pass the time of the last run).
 */
export async function catchUpAfterStockMigration(
  options: { now?: Date; after?: Date | null; siteId?: string } = {},
): Promise<CatchUpResult> {
  const now = options.now ?? new Date();
  const migratedAt = await stockMigrationTime();
  if (!migratedAt) return { status: "done" };
  if (now.getTime() - migratedAt.getTime() > CATCH_UP_WINDOW_MS) return { status: "done" };

  const since = new Date(migratedAt.getTime() - CATCH_UP_MARGIN_MS);
  // A save's time is when it started, so it can land a little before the
  // moment it becomes visible; look back a margin from the last run too.
  const lastRun = options.after ? new Date(options.after.getTime() - CATCH_UP_MARGIN_MS) : null;
  const touchedAfter = lastRun && lastRun > since ? lastRun : since;
  const touched = await prisma.$queryRaw<Array<{ productId: string }>>`
    SELECT DISTINCT "productId" FROM "ProductStock"
    WHERE "updatedAt" >= ${touchedAfter}
      AND (${options.siteId ?? null}::uuid IS NULL OR "siteId" = ${options.siteId ?? null}::uuid)
  `;
  const fixed = {} as Record<ProductSourceType, number>;
  for (const type of PRODUCT_SOURCE_TYPES) fixed[type] = 0;
  if (touched.length === 0) return { status: "checked", products: 0, fixed };

  const scope: RecordScope = { siteId: options.siteId, since, productIds: touched.map((r) => r.productId) };
  for (const type of PRODUCT_SOURCE_TYPES) {
    const ids = await mismatchedIds(type, scope);
    fixed[type] = ids.length;
    await repairRecords(type, ids, "Saved by an old server during the stock book deploy");
  }
  return { status: "checked", products: touched.length, fixed };
}

// ============================================================================
// Catch-up after the material_stock_book deploy
// ============================================================================
//
// During the rollout, servers still on the old code write material ledger
// rows without posting them to the stock book. New code always writes the
// row and its movement in one save, so a recent ledger row with no movement
// can only come from an old server. The ledger is small (hand entries plus
// one row per material per shift), so checking the last few hours is cheap.

/** How far back each pass looks. Longer than any rollout. */
const MATERIAL_CATCH_UP_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/** Post recent material ledger rows that have no movement. Returns how many it fixed. */
export async function catchUpMaterialLedger(options: { now?: Date; siteId?: string } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - MATERIAL_CATCH_UP_LOOKBACK_MS);
  const ids = await mismatchedIds("MATERIAL_LEDGER_ENTRY", { siteId: options.siteId, since });
  await repairRecords("MATERIAL_LEDGER_ENTRY", ids, "Saved by an old server during the stock book deploy");
  return ids.length;
}

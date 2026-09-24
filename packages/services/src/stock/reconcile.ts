import prisma from "@rw/db";
import { countOffBalances, rebuildProductBalances } from "./balance.js";
import { repostSources } from "./post.js";
import { expectedSelect, PRODUCT_SOURCE_TYPES, type ProductSourceType } from "./sources.js";

// ============================================================================
// Checking and repairing the stock book (ADR-0016)
// ============================================================================
//
// Each made part, scrap entry, order and count should add exactly its own
// amount to the stock book (zero once deleted). This finds records where the
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

/** Small batches keep each repair save short, so live saves are barely held up. */
const BATCH = 200;

export interface ReconcileReport {
  /** Records whose stock book total disagrees with the record, per source type. */
  mismatched: Record<ProductSourceType, number>;
  /** Stock movements whose record no longer exists. */
  movementsWithoutSource: number;
  /** StockItems pointing at a product or material that does not exist. */
  stockItemsWithoutStockable: number;
  /** Products and materials with no StockItem. Products get one when they first move. */
  stockablesWithoutStockItem: number;
  /** StockBalance rows that did not match the book before any repair. */
  balancesOff: number;
  /** True when the mismatches were fixed and balances rebuilt. */
  repaired: boolean;
}

async function mismatchedIds(type: ProductSourceType, siteId: string | null): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH facts AS (${expectedSelect(type, siteId)}),
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

/**
 * Compare the stock book against the records it comes from. With
 * `repair: true`, fix what disagrees and rebuild the balances.
 */
export async function reconcileProductStock(
  options: { siteId?: string; repair?: boolean } = {},
): Promise<ReconcileReport> {
  const siteId = options.siteId ?? null;
  const mismatched = {} as Record<ProductSourceType, number>;

  for (const type of PRODUCT_SOURCE_TYPES) {
    const ids = await mismatchedIds(type, siteId);
    mismatched[type] = ids.length;
    if (!options.repair) continue;
    for (let i = 0; i < ids.length; i += BATCH) {
      const sources = [{ type, ids: ids.slice(i, i + BATCH) }];
      // One call, so the balance rows are locked in one ordered pass.
      await prisma.$transaction(
        (tx) => repostSources(tx, { cancel: sources, post: sources }, { note: "Stock repair" }),
        {
          timeout: 60_000,
        },
      );
    }
  }

  const [{ orphans }] = await prisma.$queryRaw<Array<{ orphans: bigint }>>`
    SELECT COUNT(*) AS orphans FROM "StockMovement" m
    WHERE (${siteId}::uuid IS NULL OR m."siteId" = ${siteId}::uuid)
      AND CASE m."sourceType"
        WHEN 'INVENTORY_ITEM' THEN NOT EXISTS (SELECT 1 FROM "InventoryItem" x WHERE x.id = m."sourceId")
        WHEN 'ITEM_DISPOSITION_LOG' THEN NOT EXISTS (SELECT 1 FROM "ItemDispositionLog" x WHERE x.id = m."sourceId")
        WHEN 'ORDER_CONSUMPTION' THEN NOT EXISTS (SELECT 1 FROM "OrderConsumption" x WHERE x.id = m."sourceId")
        WHEN 'PRODUCT_STOCK_ADJUSTMENT' THEN NOT EXISTS (SELECT 1 FROM "ProductStockAdjustment" x WHERE x.id = m."sourceId")
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

  const balancesOff = await countOffBalances(siteId ?? undefined);
  if (options.repair) await rebuildProductBalances(siteId ?? undefined);

  return {
    mismatched,
    movementsWithoutSource: Number(orphans),
    stockItemsWithoutStockable: Number(missing),
    stockablesWithoutStockItem: Number(unlinked),
    balancesOff,
    repaired: options.repair === true,
  };
}

/** True when every record matches the book and every total matches the book. */
export function isClean(report: ReconcileReport): boolean {
  return Object.values(report.mismatched).every((n) => n === 0) && report.balancesOff === 0;
}

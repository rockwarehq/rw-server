import prisma, { Prisma } from "@rw/db";
import { ensureBalances, ensureProductStockItems } from "./post.js";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof prisma;

// ============================================================================
// Reading and rebuilding StockBalance (ADR-0016)
// ============================================================================

/** One product's stock, in the shape the API has always returned. */
export interface ProductStockRow {
  productId: string;
  produced: number;
  scrapped: number;
  consumed: number;
  adjustment: number;
  /** On hand, shown as at least zero. */
  available: number;
}

/**
 * Stock for these products at this site. Products that never moved come back
 * as all zeros, so callers never have to check for a missing row.
 */
export async function getProductBalances(
  client: Client,
  siteId: string,
  productIds: string[],
): Promise<Map<string, ProductStockRow>> {
  const result = new Map<string, ProductStockRow>();
  for (const productId of productIds) {
    result.set(productId, { productId, produced: 0, scrapped: 0, consumed: 0, adjustment: 0, available: 0 });
  }
  if (productIds.length === 0) return result;

  const rows = await (client as typeof prisma).$queryRaw<
    Array<{ productId: string; produced: number; scrapped: number; consumed: number; adjusted: number; onHand: number }>
  >`
    SELECT si."stockableId" AS "productId",
           b.produced::float8 AS produced,
           b.scrapped::float8 AS scrapped,
           b.consumed::float8 AS consumed,
           b.adjusted::float8 AS adjusted,
           b."onHand"::float8 AS "onHand"
    FROM "StockItem" si
    JOIN "StockBalance" b ON b."stockItemId" = si.id
    WHERE si."stockableType" = 'PRODUCT' AND si."siteId" = ${siteId}::uuid
      AND si."stockableId" = ANY(${productIds}::uuid[])
  `;
  for (const row of rows) {
    result.set(row.productId, {
      productId: row.productId,
      produced: row.produced,
      scrapped: row.scrapped,
      consumed: row.consumed,
      adjustment: row.adjusted,
      available: Math.max(row.onHand, 0),
    });
  }
  return result;
}

/**
 * Lock the balance rows of these products (making them if needed) so the
 * caller can read on-hand and change it without anyone else moving it in
 * between. Locks go in stockItemId order, the same as every other stock save.
 * Returns the plain on-hand (can be below zero) per product.
 */
export async function lockProductBalances(
  tx: Tx,
  siteId: string,
  productIds: string[],
): Promise<Map<string, Prisma.Decimal>> {
  const onHand = new Map<string, Prisma.Decimal>();
  if (productIds.length === 0) return onHand;

  await ensureProductStockItems(tx, productIds);
  const items = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "StockItem"
    WHERE "stockableType" = 'PRODUCT' AND "stockableId" = ANY(${productIds}::uuid[])
  `;
  await ensureBalances(
    tx,
    items.map((i) => i.id),
  );
  const rows = await tx.$queryRaw<Array<{ productId: string; onHand: string }>>`
    SELECT si."stockableId" AS "productId", b."onHand"::text AS "onHand"
    FROM "StockBalance" b
    JOIN "StockItem" si ON si.id = b."stockItemId"
    WHERE si."stockableType" = 'PRODUCT' AND si."siteId" = ${siteId}::uuid
      AND si."stockableId" = ANY(${productIds}::uuid[])
    ORDER BY b."stockItemId"
    FOR UPDATE OF b
  `;
  for (const row of rows) onHand.set(row.productId, new Prisma.Decimal(row.onHand));
  return onHand;
}

/** How many balance rows one rebuild step locks at a time. */
const REBUILD_CHUNK = 200;

/**
 * Rebuild StockBalance from the stock book. Safe to run any time, even while
 * servers are saving: each step first locks its balance rows (in stockItemId
 * order, like every stock save), and only then adds up the book. A save that
 * wrote movements but has not reached its balance update yet waits for the
 * lock and then adds its change on top, so nothing is lost. Steps are small
 * so live saves are only held up briefly. `productIds` narrows it to those
 * products.
 */
export async function rebuildProductBalances(siteId?: string, productIds?: string[]): Promise<void> {
  const onlyProducts = productIds ? Prisma.sql`AND "stockableId" = ANY(${productIds}::uuid[])` : Prisma.empty;
  const items = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "StockItem"
    WHERE "stockableType" = 'PRODUCT'
      AND (${siteId ?? null}::uuid IS NULL OR "siteId" = ${siteId ?? null}::uuid)
      ${onlyProducts}
    ORDER BY id
  `;
  for (let i = 0; i < items.length; i += REBUILD_CHUNK) {
    const ids = items.slice(i, i + REBUILD_CHUNK).map((r) => r.id);
    await prisma.$transaction(
      async (tx) => {
        await ensureBalances(tx, ids);
        await tx.$queryRaw`
          SELECT 1 FROM "StockBalance" WHERE "stockItemId" = ANY(${ids}::uuid[]) ORDER BY "stockItemId" FOR UPDATE
        `;
        // A new statement, so it sees everything committed before the locks were granted.
        await tx.$executeRaw`
          UPDATE "StockBalance" b
          SET "onHand" = t.on_hand, produced = t.produced, scrapped = t.scrapped,
              consumed = t.consumed, adjusted = t.adjusted, "updatedAt" = NOW()
          FROM (
            SELECT si.id,
                   COALESCE(SUM(m.quantity), 0) AS on_hand,
                   COALESCE(SUM(m.quantity) FILTER (WHERE m.kind = 'OUTPUT'), 0) AS produced,
                   COALESCE(-SUM(m.quantity) FILTER (WHERE m.kind = 'SCRAP'), 0) AS scrapped,
                   COALESCE(-SUM(m.quantity) FILTER (WHERE m.kind = 'FULFILLMENT'), 0) AS consumed,
                   COALESCE(SUM(m.quantity) FILTER (WHERE m.kind = 'ADJUSTMENT'), 0) AS adjusted
            FROM "StockItem" si
            LEFT JOIN "StockMovement" m ON m."stockItemId" = si.id
            WHERE si.id = ANY(${ids}::uuid[])
            GROUP BY si.id
          ) t
          WHERE b."stockItemId" = t.id
            AND (b."onHand", b.produced, b.scrapped, b.consumed, b.adjusted)
                IS DISTINCT FROM (t.on_hand, t.produced, t.scrapped, t.consumed, t.adjusted)
        `;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  }
}

/**
 * Count balance rows that do not match their book. Reads only; a row being
 * saved right now can show up for a moment, so check again before acting.
 */
export async function countOffBalances(siteId?: string): Promise<number> {
  const [{ off }] = await prisma.$queryRaw<Array<{ off: bigint }>>`
    SELECT COUNT(*) AS off
    FROM "StockBalance" b
    JOIN "StockItem" si ON si.id = b."stockItemId"
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(m.quantity), 0) AS on_hand,
             COALESCE(SUM(m.quantity) FILTER (WHERE m.kind = 'OUTPUT'), 0) AS produced,
             COALESCE(-SUM(m.quantity) FILTER (WHERE m.kind = 'SCRAP'), 0) AS scrapped,
             COALESCE(-SUM(m.quantity) FILTER (WHERE m.kind = 'FULFILLMENT'), 0) AS consumed,
             COALESCE(SUM(m.quantity) FILTER (WHERE m.kind = 'ADJUSTMENT'), 0) AS adjusted
      FROM "StockMovement" m WHERE m."stockItemId" = b."stockItemId"
    ) t ON true
    WHERE si."stockableType" = 'PRODUCT'
      AND (${siteId ?? null}::uuid IS NULL OR si."siteId" = ${siteId ?? null}::uuid)
      AND (b."onHand", b.produced, b.scrapped, b.consumed, b.adjusted)
          IS DISTINCT FROM (t.on_hand, t.produced, t.scrapped, t.consumed, t.adjusted)
  `;
  return Number(off);
}

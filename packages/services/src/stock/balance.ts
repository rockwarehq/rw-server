import prisma, { Prisma } from "@rw/db";
import { ensureProductStockItems } from "./post.js";

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
  await tx.$executeRaw`
    INSERT INTO "StockBalance" ("stockItemId", "siteId", "updatedAt")
    SELECT id, "siteId", NOW() FROM "StockItem"
    WHERE "stockableType" = 'PRODUCT' AND "stockableId" = ANY(${productIds}::uuid[])
    ORDER BY id
    ON CONFLICT ("stockItemId") DO NOTHING
  `;
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

/**
 * Rebuild StockBalance from the stock book. Safe to run any time and as
 * often as you like. `productIds` narrows it to those products.
 */
export async function rebuildProductBalances(siteId?: string, productIds?: string[]): Promise<void> {
  const onlyProducts = productIds ? Prisma.sql`AND si."stockableId" = ANY(${productIds}::uuid[])` : Prisma.empty;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "StockBalance" ("stockItemId", "siteId", "onHand", produced, scrapped, consumed, adjusted, "updatedAt")
        SELECT si.id, si."siteId",
               COALESCE(SUM(m.quantity), 0),
               COALESCE(SUM(m.quantity) FILTER (WHERE m.kind = 'OUTPUT'), 0),
               COALESCE(-SUM(m.quantity) FILTER (WHERE m.kind = 'SCRAP'), 0),
               COALESCE(-SUM(m.quantity) FILTER (WHERE m.kind = 'FULFILLMENT'), 0),
               COALESCE(SUM(m.quantity) FILTER (WHERE m.kind = 'ADJUSTMENT'), 0),
               NOW()
        FROM "StockItem" si
        LEFT JOIN "StockMovement" m ON m."stockItemId" = si.id
        WHERE si."stockableType" = 'PRODUCT'
          AND (${siteId ?? null}::uuid IS NULL OR si."siteId" = ${siteId ?? null}::uuid)
          ${onlyProducts}
        GROUP BY si.id, si."siteId"
        ORDER BY si.id
        ON CONFLICT ("stockItemId") DO UPDATE
        SET "onHand" = EXCLUDED."onHand", produced = EXCLUDED.produced, scrapped = EXCLUDED.scrapped,
            consumed = EXCLUDED.consumed, adjusted = EXCLUDED.adjusted, "updatedAt" = NOW()
      `;
    },
    // A whole-site rebuild reads every movement; the default 5s is too short.
    { timeout: 300_000, maxWait: 10_000 },
  );
}

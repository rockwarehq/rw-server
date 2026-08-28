import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

type TransactionClient = Prisma.TransactionClient;
type RawClient = { $queryRaw: typeof prisma.$queryRaw; $executeRaw: typeof prisma.$executeRaw };

// ============================================================================
// ProductStock — per-(site, product) on-hand aggregate
// ============================================================================
//
// A derived cache of facts, updated in the SAME transaction as the fact it
// reflects (cycle inventory creation, disposition deltas, order consumption).
// Rebuildable at any time via rederiveProductStock; the facts themselves live
// in InventoryItem, ItemDispositionLog, and OrderConsumption.

export interface ProductStockRow {
  productId: string;
  produced: number;
  scrapped: number;
  consumed: number;
  adjustment: number;
  /// GREATEST(produced − scrapped − consumed + adjustment, 0)
  available: number;
}

/**
 * Record produced quantities for a cycle's inventory items. Groups by product
 * and upserts one row per product, in productId order (consistent lock order
 * across concurrent cycle transactions — no deadlocks). Call LAST in the cycle
 * transaction to keep the row-lock window minimal.
 */
export async function applyProduction(
  tx: TransactionClient,
  siteId: string,
  items: Array<{ productId: string; quantity: number }>,
): Promise<void> {
  const byProduct = new Map<string, number>();
  for (const { productId, quantity } of items) {
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    byProduct.set(productId, (byProduct.get(productId) ?? 0) + quantity);
  }
  if (byProduct.size === 0) return;

  const txRaw = tx as unknown as RawClient;
  const productIds = [...byProduct.keys()].sort();
  for (const productId of productIds) {
    const quantity = byProduct.get(productId) ?? 0;
    await txRaw.$executeRaw`
      INSERT INTO "ProductStock" ("siteId", "productId", produced, "updatedAt")
      VALUES (${siteId}::uuid, ${productId}::uuid, ${quantity}, NOW())
      ON CONFLICT ("siteId", "productId")
      DO UPDATE SET produced = "ProductStock".produced + EXCLUDED.produced, "updatedAt" = NOW()
    `;
  }
}

/**
 * Apply a signed scrap delta (positive = more scrap, negative = a disposition
 * was reduced/removed). Accepts either the global client or a transaction.
 */
export async function applyScrapDelta(
  client: TransactionClient | typeof prisma,
  siteId: string,
  productId: string,
  delta: number,
): Promise<void> {
  if (!Number.isFinite(delta) || delta === 0) return;
  const raw = client as unknown as RawClient;
  await raw.$executeRaw`
    INSERT INTO "ProductStock" ("siteId", "productId", scrapped, "updatedAt")
    VALUES (${siteId}::uuid, ${productId}::uuid, ${delta}, NOW())
    ON CONFLICT ("siteId", "productId")
    DO UPDATE SET scrapped = "ProductStock".scrapped + EXCLUDED.scrapped, "updatedAt" = NOW()
  `;
}

/**
 * Read stock rows for a set of products. Products with no row yet are returned
 * as all-zero so callers never special-case missing rows.
 */
export async function getStock(
  client: TransactionClient | typeof prisma,
  siteId: string,
  productIds: string[],
): Promise<Map<string, ProductStockRow>> {
  const result = new Map<string, ProductStockRow>();
  for (const productId of productIds) {
    result.set(productId, { productId, produced: 0, scrapped: 0, consumed: 0, adjustment: 0, available: 0 });
  }
  if (productIds.length === 0) return result;

  const raw = client as unknown as RawClient;
  const rows = await raw.$queryRaw<
    Array<{ productId: string; produced: number; scrapped: number; consumed: number; adjustment: number }>
  >`
    SELECT "productId",
           produced::float8 AS produced,
           scrapped::float8 AS scrapped,
           consumed::float8 AS consumed,
           adjustment::float8 AS adjustment
    FROM "ProductStock"
    WHERE "siteId" = ${siteId}::uuid AND "productId" = ANY(${productIds}::uuid[])
  `;

  for (const row of rows) {
    result.set(row.productId, {
      ...row,
      available: Math.max(row.produced - row.scrapped - row.consumed + row.adjustment, 0),
    });
  }
  return result;
}

/**
 * Rebuild ProductStock from facts (InventoryItem, ItemDispositionLog,
 * OrderConsumption). Idempotent; safe to run at any time. Used by the
 * post-deploy repair script and available for support.
 */
export async function rederiveProductStock(siteId?: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const txRaw = tx as unknown as RawClient;
    // Preserve manual adjustments; recompute the three fact columns.
    await txRaw.$executeRaw`
      WITH produced AS (
        SELECT cy."siteId", pv."productId", SUM(ii.quantity) AS total
        FROM "InventoryItem" ii
        JOIN "Cycle" cy ON cy.id = ii."cycleId"
        JOIN "ProductVersion" pv ON pv.id = ii."productVersionId"
        WHERE ii."deletedAt" IS NULL
          AND (${siteId ?? null}::uuid IS NULL OR cy."siteId" = ${siteId ?? null}::uuid)
        GROUP BY cy."siteId", pv."productId"
      ),
      scrapped AS (
        SELECT idl."siteId", pv."productId", SUM(idl.quantity)::decimal(18,4) AS total
        FROM "ItemDispositionLog" idl
        JOIN "ProductVersion" pv ON pv.id = idl."productVersionId"
        WHERE idl."deletedAt" IS NULL
          AND (${siteId ?? null}::uuid IS NULL OR idl."siteId" = ${siteId ?? null}::uuid)
        GROUP BY idl."siteId", pv."productId"
      ),
      consumed AS (
        SELECT oc."siteId", oc."productId", SUM(oc.quantity) AS total
        FROM "OrderConsumption" oc
        WHERE (${siteId ?? null}::uuid IS NULL OR oc."siteId" = ${siteId ?? null}::uuid)
        GROUP BY oc."siteId", oc."productId"
      ),
      merged AS (
        SELECT COALESCE(p."siteId", s."siteId", c."siteId") AS "siteId",
               COALESCE(p."productId", s."productId", c."productId") AS "productId",
               COALESCE(p.total, 0) AS produced,
               COALESCE(s.total, 0) AS scrapped,
               COALESCE(c.total, 0) AS consumed
        FROM produced p
        FULL OUTER JOIN scrapped s ON s."siteId" = p."siteId" AND s."productId" = p."productId"
        FULL OUTER JOIN consumed c
          ON c."siteId" = COALESCE(p."siteId", s."siteId")
         AND c."productId" = COALESCE(p."productId", s."productId")
      )
      INSERT INTO "ProductStock" ("siteId", "productId", produced, scrapped, consumed, "updatedAt")
      SELECT "siteId", "productId", produced, scrapped, consumed, NOW() FROM merged
      ON CONFLICT ("siteId", "productId")
      DO UPDATE SET produced = EXCLUDED.produced,
                    scrapped = EXCLUDED.scrapped,
                    consumed = EXCLUDED.consumed,
                    "updatedAt" = NOW()
    `;
    // Zero out rows whose facts have entirely disappeared (rare: deletions).
    await txRaw.$executeRaw`
      UPDATE "ProductStock" ps
      SET produced = 0, scrapped = 0, consumed = 0, "updatedAt" = NOW()
      WHERE (${siteId ?? null}::uuid IS NULL OR ps."siteId" = ${siteId ?? null}::uuid)
        AND (produced <> 0 OR scrapped <> 0 OR consumed <> 0)
        AND NOT EXISTS (
          SELECT 1 FROM "InventoryItem" ii
          JOIN "Cycle" cy ON cy.id = ii."cycleId"
          JOIN "ProductVersion" pv ON pv.id = ii."productVersionId"
          WHERE ii."deletedAt" IS NULL AND cy."siteId" = ps."siteId" AND pv."productId" = ps."productId"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "ItemDispositionLog" idl
          JOIN "ProductVersion" pv ON pv.id = idl."productVersionId"
          WHERE idl."deletedAt" IS NULL AND idl."siteId" = ps."siteId" AND pv."productId" = ps."productId"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "OrderConsumption" oc
          WHERE oc."siteId" = ps."siteId" AND oc."productId" = ps."productId"
        )
    `;
  });
}

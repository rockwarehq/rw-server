import prisma, { Prisma } from "@rw/db";
import { ensureBalances, ensureMaterialStockItems, ensureProductStockItems } from "./post.js";

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

/**
 * Totals per stock item from the book, each movement converted to the item's
 * baseUnit one row at a time (the same way posting adds them up).
 * Columns: id, on_hand, produced, scrapped, consumed, adjusted, received, issued.
 */
function bookTotals(where: Prisma.Sql, asOf: Date | null = null): Prisma.Sql {
  const q = Prisma.sql`stock_convert(m.quantity, m.unit, si."baseUnit")`;
  return Prisma.sql`
    SELECT si.id,
           COALESCE(SUM(${q}), 0) AS on_hand,
           COALESCE(SUM(${q}) FILTER (WHERE m.kind = 'OUTPUT'), 0) AS produced,
           COALESCE(-SUM(${q}) FILTER (WHERE m.kind = 'SCRAP'), 0) AS scrapped,
           COALESCE(-SUM(${q}) FILTER (WHERE m.kind = 'FULFILLMENT'), 0) AS consumed,
           COALESCE(SUM(${q}) FILTER (WHERE m.kind = 'ADJUSTMENT'), 0) AS adjusted,
           COALESCE(SUM(${q}) FILTER (WHERE m.kind IN ('RECEIPT', 'TRANSFER_IN', 'OPENING_BALANCE')), 0) AS received,
           COALESCE(-SUM(${q}) FILTER (WHERE m.kind IN ('USAGE', 'WRITE_OFF', 'TRANSFER_OUT')), 0) AS issued
    FROM "StockItem" si
    LEFT JOIN "StockMovement" m ON m."stockItemId" = si.id
      AND (${asOf}::timestamptz IS NULL OR m."occurredAt" <= ${asOf}::timestamptz)
    WHERE ${where}
    GROUP BY si.id`;
}

/** How many balance rows one rebuild step locks at a time. */
const REBUILD_CHUNK = 200;

/** Which stock items a rebuild or check covers. Every field narrows it. */
export interface BalanceScope {
  siteId?: string | null;
  stockableType?: "PRODUCT" | "MATERIAL";
  stockItemIds?: string[];
  productIds?: string[];
}

function scopeWhere(scope: BalanceScope, alias = "si"): Prisma.Sql {
  const a = Prisma.raw(alias);
  const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (scope.siteId) parts.push(Prisma.sql`${a}."siteId" = ${scope.siteId}::uuid`);
  if (scope.stockableType) parts.push(Prisma.sql`${a}."stockableType" = ${scope.stockableType}::"StockableType"`);
  if (scope.stockItemIds) parts.push(Prisma.sql`${a}.id = ANY(${scope.stockItemIds}::uuid[])`);
  if (scope.productIds) {
    parts.push(Prisma.sql`${a}."stockableType" = 'PRODUCT' AND ${a}."stockableId" = ANY(${scope.productIds}::uuid[])`);
  }
  return Prisma.join(parts, " AND ");
}

/**
 * Rebuild StockBalance from the stock book. Safe to run any time, even while
 * servers are saving: each step first locks its balance rows (in stockItemId
 * order, like every stock save), and only then adds up the book. A save that
 * wrote movements but has not reached its balance update yet waits for the
 * lock and then adds its change on top, so nothing is lost. Steps are small
 * so live saves are only held up briefly.
 */
export async function rebuildBalances(scope: BalanceScope = {}): Promise<void> {
  const items = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT si.id FROM "StockItem" si WHERE ${scopeWhere(scope)} ORDER BY si.id
  `;
  for (let i = 0; i < items.length; i += REBUILD_CHUNK) {
    const ids = items.slice(i, i + REBUILD_CHUNK).map((r) => r.id);
    await prisma.$transaction((tx) => rebuildItemBalances(tx, ids), { timeout: 60_000, maxWait: 10_000 });
  }
}

/**
 * Rebuild these items' balances inside the caller's save (for example when
 * a material's stock unit changes). Locks in stockItemId order.
 */
export async function rebuildItemBalances(tx: Tx, stockItemIds: string[]): Promise<void> {
  const ids = [...stockItemIds].sort();
  if (ids.length === 0) return;
  await ensureBalances(tx, ids);
  await tx.$queryRaw`
    SELECT 1 FROM "StockBalance" WHERE "stockItemId" = ANY(${ids}::uuid[]) ORDER BY "stockItemId" FOR UPDATE
  `;
  // A new statement, so it sees everything committed before the locks were granted.
  await tx.$executeRaw`
    UPDATE "StockBalance" b
    SET "onHand" = t.on_hand, produced = t.produced, scrapped = t.scrapped, consumed = t.consumed,
        adjusted = t.adjusted, received = t.received, issued = t.issued, "updatedAt" = NOW()
    FROM (${bookTotals(Prisma.sql`si.id = ANY(${ids}::uuid[])`)}) t
    WHERE b."stockItemId" = t.id
      AND (b."onHand", b.produced, b.scrapped, b.consumed, b.adjusted, b.received, b.issued)
          IS DISTINCT FROM (t.on_hand, t.produced, t.scrapped, t.consumed, t.adjusted, t.received, t.issued)
  `;
}

/** Rebuild part balances (kept for existing callers). */
export async function rebuildProductBalances(siteId?: string, productIds?: string[]): Promise<void> {
  return rebuildBalances({ siteId, stockableType: "PRODUCT", productIds });
}

/**
 * Count balance rows that do not match their book. Reads only; a row being
 * saved right now can show up for a moment, so check again before acting.
 */
export async function countOffBalances(scope: BalanceScope | string = {}): Promise<number> {
  const s: BalanceScope = typeof scope === "string" ? { siteId: scope } : scope;
  const [{ off }] = await prisma.$queryRaw<Array<{ off: bigint }>>`
    SELECT COUNT(*) AS off
    FROM "StockBalance" b
    JOIN (${bookTotals(scopeWhere(s))}) t ON t.id = b."stockItemId"
    WHERE (b."onHand", b.produced, b.scrapped, b.consumed, b.adjusted, b.received, b.issued)
          IS DISTINCT FROM (t.on_hand, t.produced, t.scrapped, t.consumed, t.adjusted, t.received, t.issued)
  `;
  return Number(off);
}

// ============================================================================
// Materials
// ============================================================================

/** A material's stock record: its stock unit (blank = not tracked) and totals. */
export interface MaterialStock {
  stockItemId: string;
  baseUnit: string;
  onHand: Prisma.Decimal;
  received: Prisma.Decimal;
  adjusted: Prisma.Decimal;
  issued: Prisma.Decimal;
}

/** Make sure the material has its StockItem and return its id and unit. */
async function materialItem(tx: Tx, materialId: string): Promise<{ id: string; baseUnit: string }> {
  await ensureMaterialStockItems(tx, [materialId]);
  const [item] = await tx.$queryRaw<Array<{ id: string; baseUnit: string }>>`
    SELECT id, "baseUnit" FROM "StockItem" WHERE "stockableType" = 'MATERIAL' AND "stockableId" = ${materialId}::uuid
  `;
  return item;
}

/**
 * Set a material's stock unit (blank = not tracked). When it changes, the
 * material's totals are rebuilt in the new unit, converted; its movements
 * keep the units they were written in, so nothing is lost. Runs inside the
 * caller's save.
 */
export async function setMaterialStockUnit(tx: Tx, materialId: string, unit: string): Promise<void> {
  const item = await materialItem(tx, materialId);
  if (item.baseUnit === unit) return;
  await tx.stockItem.update({ where: { id: item.id }, data: { baseUnit: unit } });
  await rebuildItemBalances(tx, [item.id]);
}

/**
 * Lock a material's balance row (making it if needed) so the caller can read
 * on-hand and change it without anyone else moving it in between.
 */
export async function lockMaterialBalance(tx: Tx, materialId: string): Promise<MaterialStock> {
  const item = await materialItem(tx, materialId);
  await ensureBalances(tx, [item.id]);
  const [b] = await tx.$queryRaw<Array<{ onHand: string; received: string; adjusted: string; issued: string }>>`
    SELECT "onHand"::text AS "onHand", received::text, adjusted::text, issued::text
    FROM "StockBalance" WHERE "stockItemId" = ${item.id}::uuid FOR UPDATE
  `;
  return {
    stockItemId: item.id,
    baseUnit: item.baseUnit,
    onHand: new Prisma.Decimal(b.onHand),
    received: new Prisma.Decimal(b.received),
    adjusted: new Prisma.Decimal(b.adjusted),
    issued: new Prisma.Decimal(b.issued),
  };
}

/**
 * A material's totals, read from StockBalance, or added up from the book as
 * of a moment when `asOf` is given. Null when the material has no StockItem.
 */
export async function getMaterialStock(materialId: string, asOf?: Date | null): Promise<MaterialStock | null> {
  const [row] = await prisma.$queryRaw<
    Array<{ id: string; baseUnit: string; onHand: string; received: string; adjusted: string; issued: string }>
  >`
    SELECT si.id, si."baseUnit",
           t.on_hand::text AS "onHand", t.received::text, t.adjusted::text, t.issued::text
    FROM "StockItem" si
    JOIN (${
      asOf
        ? bookTotals(Prisma.sql`si."stockableType" = 'MATERIAL' AND si."stockableId" = ${materialId}::uuid`, asOf)
        : Prisma.sql`
            SELECT b."stockItemId" AS id, b."onHand" AS on_hand, b.received, b.adjusted, b.issued
            FROM "StockBalance" b
            JOIN "StockItem" x ON x.id = b."stockItemId"
            WHERE x."stockableType" = 'MATERIAL' AND x."stockableId" = ${materialId}::uuid`
    }) t ON t.id = si.id
  `;
  if (!row) return null;
  return {
    stockItemId: row.id,
    baseUnit: row.baseUnit,
    onHand: new Prisma.Decimal(row.onHand),
    received: new Prisma.Decimal(row.received),
    adjusted: new Prisma.Decimal(row.adjusted),
    issued: new Prisma.Decimal(row.issued),
  };
}

/**
 * What a material's open shifts have used so far (staging not yet flushed to
 * the book), converted to its stock unit. It counts against on-hand now even
 * though it is not in the book yet.
 */
export async function pendingMaterialUsage(client: Client, materialId: string, baseUnit: string) {
  const [row] = await (client as typeof prisma).$queryRaw<Array<{ pending: string }>>`
    SELECT COALESCE(SUM(stock_convert(quantity, unit::text, ${baseUnit})), 0)::text AS pending
    FROM "MaterialShiftUsage"
    WHERE "materialId" = ${materialId}::uuid AND "flushedAt" IS NULL
  `;
  return new Prisma.Decimal(row?.pending ?? 0);
}

import { Prisma, type StockMovementKind } from "@rw/db";
import {
  type BookSourceType,
  isMaterialSource,
  MOVEMENT_COLUMNS,
  materialIdsSelect,
  movementSelect,
  productIdsSelect,
} from "./sources.js";

type Tx = Prisma.TransactionClient;

// ============================================================================
// Posting to the stock book (ADR-0016)
// ============================================================================
//
// The only way stock changes. A caller saves its own record (a made part, a
// scrap entry, an order, a count) and then posts it here in the same save.
// Rows are only added: to change a record's effect, cancel its movement with
// reverseSources and post it again.
//
// Every save that touches StockBalance locks its rows in stockItemId order, so
// two saves can never wait on each other in a circle. Post everything a save
// changes in ONE call (postSources, or repostSources when it also cancels) so
// the locks are taken in one pass.

export interface StockSource {
  type: BookSourceType;
  ids: string[];
}

export interface PostNote {
  /** Who did it, for cancelling rows. New rows copy it from their source record. */
  performedByUserId?: string | null;
  note?: string | null;
}

/** Movement totals per item and kind, already converted to the item's baseUnit. */
interface KindTotal {
  stockItemId: string;
  kind: StockMovementKind;
  quantity: string;
}

/**
 * Make sure each of these products has a StockItem. Products made by scripts
 * that skip the services may not have one yet. Inserts go in product order so
 * two saves never block each other in a circle.
 */
export async function ensureProductStockItems(tx: Tx, productIds: Prisma.Sql | string[]): Promise<void> {
  const ids = Array.isArray(productIds) ? Prisma.sql`SELECT unnest(${productIds}::uuid[])` : productIds;
  await tx.$executeRaw`
    INSERT INTO "StockItem" ("id", "stockableType", "stockableId", "siteId", "updatedAt")
    SELECT gen_random_uuid(), 'PRODUCT', p.id, p."siteId", NOW()
    FROM "Product" p
    WHERE p.id IN (${ids})
      AND NOT EXISTS (
        SELECT 1 FROM "StockItem" si WHERE si."stockableType" = 'PRODUCT' AND si."stockableId" = p.id
      )
    ORDER BY p.id
    ON CONFLICT ("stockableType", "stockableId") DO NOTHING
  `;
}

/**
 * Make sure each of these materials has a StockItem, with its stock unit
 * taken from the material's current weight unit (blank = not tracked).
 * Materials made by scripts that skip the services may not have one yet.
 */
export async function ensureMaterialStockItems(tx: Tx, materialIds: Prisma.Sql | string[]): Promise<void> {
  const ids = Array.isArray(materialIds) ? Prisma.sql`SELECT unnest(${materialIds}::uuid[])` : materialIds;
  await tx.$executeRaw`
    INSERT INTO "StockItem" ("id", "stockableType", "stockableId", "siteId", "baseUnit", "updatedAt")
    SELECT gen_random_uuid(), 'MATERIAL', m.id, m."siteId", COALESCE(mv."weightUnits"::text, ''), NOW()
    FROM "Material" m
    LEFT JOIN "MaterialVersion" mv ON mv.id = m."currentVersionId"
    WHERE m.id IN (${ids})
      AND NOT EXISTS (
        SELECT 1 FROM "StockItem" si WHERE si."stockableType" = 'MATERIAL' AND si."stockableId" = m.id
      )
    ORDER BY m.id
    ON CONFLICT ("stockableType", "stockableId") DO NOTHING
  `;
}

/** Make sure the StockItems these records post to exist. */
function ensureStockItemsFor(tx: Tx, type: BookSourceType, ids: string[]): Promise<void> {
  return isMaterialSource(type)
    ? ensureMaterialStockItems(tx, materialIdsSelect(ids))
    : ensureProductStockItems(tx, productIdsSelect(type, ids));
}

/**
 * Post the stock movements for these records. Records already posted (same
 * key) are skipped, so calling this twice is safe. Returns the stock items
 * whose balance changed.
 */
export async function postSources(tx: Tx, sources: StockSource[]): Promise<string[]> {
  return applyToBalances(tx, await insertPosts(tx, sources));
}

/**
 * Cancel the current movement of each of these records: add a row with the
 * opposite amount, the same shift and the same time. Records with nothing to
 * cancel are skipped, and a movement can only be cancelled once.
 */
export async function reverseSources(tx: Tx, sources: StockSource[], by: PostNote = {}): Promise<string[]> {
  return applyToBalances(tx, await insertReversals(tx, sources, by));
}

/**
 * Cancel what `cancel` records did to stock, then post `post` records, and
 * update the totals ONCE. Use this whenever one save both cancels and posts
 * (an edited scrap entry, a job history amendment, a repair): two separate
 * calls would lock balance rows in two passes, and two saves doing that in
 * opposite orders wait on each other forever.
 */
export async function repostSources(
  tx: Tx,
  change: { cancel: StockSource[]; post: StockSource[] },
  by: PostNote = {},
): Promise<string[]> {
  const cancelled = await insertReversals(tx, change.cancel, by);
  const posted = await insertPosts(tx, change.post);
  return applyToBalances(tx, [...cancelled, ...posted]);
}

/** Add the movement rows for these records. Does not touch StockBalance. */
async function insertPosts(tx: Tx, sources: StockSource[]): Promise<KindTotal[]> {
  const totals: KindTotal[] = [];
  for (const { type, ids } of sources) {
    if (ids.length === 0) continue;
    await ensureStockItemsFor(tx, type, ids);
    const rows = await tx.$queryRaw<KindTotal[]>`
      WITH posted AS (
        INSERT INTO "StockMovement" (${MOVEMENT_COLUMNS})
        ${movementSelect(type, ids)}
        ON CONFLICT ("idempotencyKey") DO NOTHING
        RETURNING "stockItemId", "kind", "quantity", "unit"
      )
      ${convertedTotals("posted")}
    `;
    totals.push(...rows);
  }
  return totals;
}

/** Add the cancelling rows for these records. Does not touch StockBalance. */
async function insertReversals(tx: Tx, sources: StockSource[], by: PostNote): Promise<KindTotal[]> {
  const totals: KindTotal[] = [];
  for (const { type, ids } of sources) {
    if (ids.length === 0) continue;
    const rows = await tx.$queryRaw<KindTotal[]>`
      WITH cancelled AS (
        INSERT INTO "StockMovement" (${MOVEMENT_COLUMNS}, "reversesMovementId", "lotId")
        SELECT gen_random_uuid(), m."stockItemId", m."siteId", m."kind", -m."quantity", m."unit",
               m."sourceType", m."sourceId", 'REVERSAL:' || m.id, m."stationId", m."shiftInstanceId",
               m."isScheduled", m."businessDate", ${by.performedByUserId ?? null}::uuid, m."occurredAt", NOW(),
               ${by.note ?? null}, m.id, m."lotId"
        FROM "StockMovement" m
        WHERE m."sourceType" = ${type}::"StockSourceType" AND m."sourceId" = ANY(${ids}::uuid[])
          AND m."reversesMovementId" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "StockMovement" r WHERE r."reversesMovementId" = m.id)
        ORDER BY m.id
        ON CONFLICT DO NOTHING
        RETURNING "stockItemId", "kind", "quantity", "unit"
      )
      ${convertedTotals("cancelled")}
    `;
    totals.push(...rows);
  }
  return totals;
}

/**
 * Totals per item and kind from just-inserted movements, each converted to
 * its item's baseUnit one row at a time (stock_convert rounds per row). The
 * rebuild adds up the same way, so kept-up totals and rebuilt totals agree.
 */
function convertedTotals(cte: "posted" | "cancelled"): Prisma.Sql {
  return Prisma.sql`
    SELECT r."stockItemId", r."kind", SUM(stock_convert(r."quantity", r."unit", si."baseUnit"))::text AS quantity
    FROM ${Prisma.raw(cte)} r JOIN "StockItem" si ON si.id = r."stockItemId"
    GROUP BY 1, 2`;
}

/**
 * Make sure these stock items have a StockBalance row (made the first time an
 * item moves). Inserts go in stockItemId order, like every other stock lock.
 */
export async function ensureBalances(tx: Tx, stockItemIds: string[]): Promise<void> {
  if (stockItemIds.length === 0) return;
  await tx.$executeRaw`
    INSERT INTO "StockBalance" ("stockItemId", "siteId", "updatedAt")
    SELECT id, "siteId", NOW() FROM "StockItem" WHERE id = ANY(${stockItemIds}::uuid[]) ORDER BY id
    ON CONFLICT ("stockItemId") DO NOTHING
  `;
}

type BalanceColumn = "produced" | "scrapped" | "consumed" | "adjusted" | "received" | "issued";
const BALANCE_COLUMNS: readonly BalanceColumn[] = [
  "produced",
  "scrapped",
  "consumed",
  "adjusted",
  "received",
  "issued",
];

/**
 * Where each kind lands in StockBalance, and whether it is kept as a plus
 * total of minus movements (scrap, orders and material issues go out of stock
 * but are shown as plus numbers).
 */
function columnFor(kind: StockMovementKind): { column: BalanceColumn; outflow: boolean } {
  switch (kind) {
    case "OUTPUT":
      return { column: "produced", outflow: false };
    case "SCRAP":
      return { column: "scrapped", outflow: true };
    case "FULFILLMENT":
      return { column: "consumed", outflow: true };
    case "ADJUSTMENT":
      return { column: "adjusted", outflow: false };
    case "RECEIPT":
    case "TRANSFER_IN":
    case "OPENING_BALANCE":
      return { column: "received", outflow: false };
    case "USAGE":
    case "WRITE_OFF":
    case "TRANSFER_OUT":
      return { column: "issued", outflow: true };
  }
}

/** Add movement totals to StockBalance, locking rows in stockItemId order. */
async function applyToBalances(tx: Tx, totals: KindTotal[]): Promise<string[]> {
  const zero = () => new Prisma.Decimal(0);
  const byItem = new Map<string, Record<"onHand" | BalanceColumn, Prisma.Decimal>>();
  for (const { stockItemId, kind, quantity } of totals) {
    const q = new Prisma.Decimal(quantity);
    if (q.isZero()) continue;
    const row = byItem.get(stockItemId) ?? {
      onHand: zero(),
      produced: zero(),
      scrapped: zero(),
      consumed: zero(),
      adjusted: zero(),
      received: zero(),
      issued: zero(),
    };
    const { column, outflow } = columnFor(kind);
    row.onHand = row.onHand.plus(q);
    row[column] = outflow ? row[column].minus(q) : row[column].plus(q);
    byItem.set(stockItemId, row);
  }
  if (byItem.size === 0) return [];

  const ids = [...byItem.keys()].sort();
  await ensureBalances(tx, ids);
  await tx.$queryRaw`
    SELECT 1 FROM "StockBalance" WHERE "stockItemId" = ANY(${ids}::uuid[]) ORDER BY "stockItemId" FOR UPDATE
  `;
  const values = Prisma.join(
    ids.map((id) => {
      const r = byItem.get(id) as Record<"onHand" | BalanceColumn, Prisma.Decimal>;
      const amounts = [r.onHand, ...BALANCE_COLUMNS.map((c) => r[c])].map((d) => Prisma.sql`${d.toString()}::numeric`);
      return Prisma.sql`(${id}::uuid, ${Prisma.join(amounts)})`;
    }),
  );
  await tx.$executeRaw`
    UPDATE "StockBalance" b
    SET "onHand" = b."onHand" + v.on_hand,
        "produced" = b."produced" + v.produced,
        "scrapped" = b."scrapped" + v.scrapped,
        "consumed" = b."consumed" + v.consumed,
        "adjusted" = b."adjusted" + v.adjusted,
        "received" = b."received" + v.received,
        "issued" = b."issued" + v.issued,
        "updatedAt" = NOW()
    FROM (VALUES ${values}) AS v(id, on_hand, produced, scrapped, consumed, adjusted, received, issued)
    WHERE b."stockItemId" = v.id
  `;
  return ids;
}

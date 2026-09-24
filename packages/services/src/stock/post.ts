import { Prisma } from "@rw/db";
import {
  type BookSourceType,
  isMaterialSource,
  MOVEMENT_COLUMNS,
  materialIdsSelect,
  movementSelect,
  productIdsSelect,
} from "./sources.js";
import { totalsSelect } from "./totals.js";

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

/** A movement just written, and the stock item it belongs to. */
interface NewMovement {
  id: string;
  stockItemId: string;
}

/** Add the movement rows for these records. Does not touch StockBalance. */
async function insertPosts(tx: Tx, sources: StockSource[]): Promise<NewMovement[]> {
  const rows: NewMovement[] = [];
  for (const { type, ids } of sources) {
    if (ids.length === 0) continue;
    await ensureStockItemsFor(tx, type, ids);
    rows.push(
      ...(await tx.$queryRaw<NewMovement[]>`
        INSERT INTO "StockMovement" (${MOVEMENT_COLUMNS})
        ${movementSelect(type, ids)}
        ON CONFLICT ("idempotencyKey") DO NOTHING
        RETURNING "id", "stockItemId"
      `),
    );
  }
  return rows;
}

/** Add the cancelling rows for these records. Does not touch StockBalance. */
async function insertReversals(tx: Tx, sources: StockSource[], by: PostNote): Promise<NewMovement[]> {
  const rows: NewMovement[] = [];
  for (const { type, ids } of sources) {
    if (ids.length === 0) continue;
    rows.push(
      ...(await tx.$queryRaw<NewMovement[]>`
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
        RETURNING "id", "stockItemId"
      `),
    );
  }
  return rows;
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

/**
 * Add new movements to StockBalance. The balance rows are locked first, in
 * stockItemId order, and only then are the movements converted to each
 * item's baseUnit and added. A material's unit only changes under that same
 * lock (setMaterialStockUnit), so a save can never add a total worked out in
 * a unit that changed underneath it.
 */
async function applyToBalances(tx: Tx, movements: NewMovement[]): Promise<string[]> {
  if (movements.length === 0) return [];
  const ids = [...new Set(movements.map((m) => m.stockItemId))].sort();
  await ensureBalances(tx, ids);
  await tx.$queryRaw`
    SELECT 1 FROM "StockBalance" WHERE "stockItemId" = ANY(${ids}::uuid[]) ORDER BY "stockItemId" FOR UPDATE
  `;
  // A new statement, so it reads each item's unit as it is now that we hold the lock.
  const movementIds = movements.map((m) => m.id);
  await tx.$executeRaw`
    UPDATE "StockBalance" b
    SET "onHand" = b."onHand" + t.on_hand,
        "produced" = b."produced" + t.produced,
        "scrapped" = b."scrapped" + t.scrapped,
        "consumed" = b."consumed" + t.consumed,
        "adjusted" = b."adjusted" + t.adjusted,
        "received" = b."received" + t.received,
        "issued" = b."issued" + t.issued,
        "updatedAt" = NOW()
    FROM (${totalsSelect(
      Prisma.sql`FROM "StockMovement" m JOIN "StockItem" si ON si.id = m."stockItemId" WHERE m.id = ANY(${movementIds}::uuid[])`,
    )}) t
    WHERE b."stockItemId" = t.id
  `;
  return ids;
}

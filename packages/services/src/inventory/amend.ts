import { Prisma, type WeightUnit } from "@rw/db";
import type { AmendContext } from "../history/context.js";
import { repostSources } from "../stock/post.js";
import { applyShiftUsage, materialUsage, type ShiftUsageScope } from "./inventory.js";

export interface ReassignItemsSummary {
  itemsRemoved: number;
  itemsCreated: number;
  /** ADJUSTMENT ledger rows posted for shifts whose usage was already flushed. */
  ledgerAdjustments: number;
}

interface ItemRow {
  id: string;
  jobId: string | null;
  shiftInstanceId: string | null;
  workcenterId: string | null;
  businessDate: Date | null;
  isScheduled: boolean;
}

/**
 * Items were produced from the old job's products, so they are soft-deleted
 * and recreated from the amended job in one set-based insert (the station
 * lock is held throughout, so this must not scale per cycle). Material staging
 * moves with them for shifts that are still open; a flushed shift's PRODUCTION
 * entries are immutable, so the material difference is posted as a signed
 * ADJUSTMENT per material instead. Scrap rows are left alone: the job on a
 * scrap row is what the operator entered and only they change it.
 */
export async function reassignItems(ctx: AmendContext, cycleIds: string[]): Promise<ReassignItemsSummary> {
  const { tx, siteId, stationId, from, toEff, job, amendmentId } = ctx;
  const summary: ReassignItemsSummary = { itemsRemoved: 0, itemsCreated: 0, ledgerAdjustments: 0 };
  if (!job || cycleIds.length === 0) return summary;

  const removed = await tx.$queryRaw<ItemRow[]>`
    UPDATE "InventoryItem" SET "deletedAt" = NOW(), "updatedAt" = NOW()
    WHERE "cycleId" = ANY(${cycleIds}::uuid[]) AND "deletedAt" IS NULL
    RETURNING id, "jobId", "shiftInstanceId", "workcenterId", "businessDate", "isScheduled"
  `;
  summary.itemsRemoved = removed.length;

  // Same row shape createFromCycle produces: one item per active JobProduct,
  // quantity = cycle quantity (default 1) × product quantity, dims from the cycle.
  const created = await tx.$queryRaw<ItemRow[]>`
    INSERT INTO "InventoryItem" (id, "cycleId", "jobProductVersionId", "productVersionId", "toolVersionId", "toolCavityVersionId",
      quantity, "quantityUnit", "modeId", "siteId", "stationId", "workcenterId", "jobId", "productId", "toolId",
      "shiftInstanceId", "businessDate", "isScheduled", "amendmentId", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), c.id, jp."currentVersionId", p."currentVersionId", t."currentVersionId", tc."currentVersionId",
      (CASE WHEN c.quantity > 0 THEN c.quantity ELSE 1 END) * jpb.quantity, c."quantityUnit", c."modeId",
      c."siteId", c."stationId", c."workcenterId", ${job.id}::uuid, jp."productId", jp."toolId",
      c."shiftInstanceId", c."businessDate", c."isScheduled", ${amendmentId}::uuid, NOW(), NOW()
    FROM "Cycle" c
    CROSS JOIN "JobProduct" jp
    JOIN "JobProductVersion" jpb ON jpb.id = jp."currentVersionId"
    JOIN "Product" p ON p.id = jp."productId"
    LEFT JOIN "Tool" t ON t.id = jp."toolId"
    LEFT JOIN "ToolCavity" tc ON tc.id = jp."toolCavityId"
    WHERE c.id = ANY(${cycleIds}::uuid[])
      AND jp."jobId" = ${job.id}::uuid AND jp."deletedAt" IS NULL AND jpb."isActive" = true AND jpb.quantity > 0
      AND p."currentVersionId" IS NOT NULL
    RETURNING id, "jobId", "shiftInstanceId", "workcenterId", "businessDate", "isScheduled"
  `;
  summary.itemsCreated = created.length;

  if (created.length > 0) {
    await tx.$executeRaw`
      INSERT INTO "_InventoryItemToProductMaterialVersion" ("A", "B")
      SELECT ii.id, pm."currentVersionId"
      FROM "InventoryItem" ii
      JOIN "ProductMaterial" pm ON pm."productId" = ii."productId"
      JOIN "Material" m ON m.id = pm."materialId"
      LEFT JOIN "ProductMaterialAltGroup" mag ON mag.id = pm."altGroupId"
      WHERE ii.id = ANY(${created.map((r) => r.id)}::uuid[])
        AND pm."currentVersionId" IS NOT NULL
        AND pm."archivedAt" IS NULL AND m."archivedAt" IS NULL AND m."deletedAt" IS NULL
        AND (pm."altGroupId" IS NULL OR mag."activeProductMaterialId" = pm.id)
      ON CONFLICT DO NOTHING
    `;
  }

  const shiftIds = [
    ...new Set([...removed, ...created].map((r) => r.shiftInstanceId).filter((id): id is string => !!id)),
  ];
  const flushed = new Set(
    (
      await tx.materialShiftUsage.findMany({
        where: { shiftInstanceId: { in: shiftIds }, flushedAt: { not: null } },
        select: { shiftInstanceId: true },
        distinct: ["shiftInstanceId"],
      })
    ).map((r) => r.shiftInstanceId),
  );

  for (const [rows, sign] of [
    [removed, -1],
    [created, 1],
  ] as const) {
    const groups = new Map<string, { scope: ShiftUsageScope; ids: string[] }>();
    for (const it of rows) {
      if (!it.shiftInstanceId || !it.jobId || flushed.has(it.shiftInstanceId)) continue;
      const key = `${it.shiftInstanceId}:${it.jobId}`;
      const group = groups.get(key) ?? {
        scope: {
          siteId,
          stationId,
          shiftInstanceId: it.shiftInstanceId,
          jobId: it.jobId,
          workcenterId: it.workcenterId,
          businessDate: it.businessDate,
          isScheduled: it.isScheduled,
        },
        ids: [],
      };
      group.ids.push(it.id);
      groups.set(key, group);
    }
    for (const { scope, ids } of groups.values()) await applyShiftUsage(tx, scope, ids, sign);
  }
  const ledgerIds: string[] = [];
  for (const shiftInstanceId of flushed) {
    const of = (rows: ItemRow[]) => rows.filter((r) => r.shiftInstanceId === shiftInstanceId).map((r) => r.id);
    const businessDate = removed.find((r) => r.shiftInstanceId === shiftInstanceId)?.businessDate ?? null;
    ledgerIds.push(
      ...(await adjustLedger(
        tx,
        { siteId, shiftInstanceId, businessDate, reference: amendmentId },
        of(removed),
        of(created),
      )),
    );
  }
  summary.ledgerAdjustments = ledgerIds.length;

  // Stock book, in ONE call so every balance row (the old and new parts, and
  // the materials) is locked in a single ordered pass: cancel the removed
  // items' movements, post the recreated items and the material adjustments.
  // This is the whole stock effect of an amendment, so nothing has to be
  // rebuilt afterwards.
  await repostSources(
    tx,
    {
      cancel: [{ type: "INVENTORY_ITEM", ids: removed.map((r) => r.id) }],
      post: [
        { type: "INVENTORY_ITEM", ids: created.map((r) => r.id) },
        { type: "MATERIAL_LEDGER_ENTRY", ids: ledgerIds },
      ],
    },
    { note: "Job history amendment" },
  );

  return summary;
}

/**
 * Credit the removed items' material back and debit the created items'; one
 * ADJUSTMENT per material with a non-zero net. Returns the new ledger ids;
 * the caller posts them to the stock book with the rest of the amendment.
 */
async function adjustLedger(
  tx: AmendContext["tx"],
  stamp: { siteId: string; shiftInstanceId: string; businessDate: Date | null; reference: string },
  removedIds: string[],
  createdIds: string[],
): Promise<string[]> {
  const net = new Map<string, { materialId: string; unit: WeightUnit; qty: Prisma.Decimal }>();
  for (const [ids, sign] of [
    [removedIds, 1],
    [createdIds, -1],
  ] as const) {
    for (const u of await materialUsage(tx, ids)) {
      const key = `${u.materialId}|${u.unit}`;
      const entry = net.get(key) ?? { materialId: u.materialId, unit: u.unit, qty: new Prisma.Decimal(0) };
      entry.qty = entry.qty.add(u.qty.mul(sign));
      net.set(key, entry);
    }
  }
  const ids: string[] = [];
  for (const { materialId, unit, qty } of net.values()) {
    if (qty.isZero()) continue;
    const entry = await tx.materialLedgerEntry.create({
      data: { ...stamp, materialId, kind: "ADJUSTMENT", quantity: qty, unit, note: "Job history amendment" },
      select: { id: true },
    });
    ids.push(entry.id);
  }
  return ids;
}

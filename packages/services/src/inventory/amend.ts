import type { AmendContext } from "../history/context.js";
import { applyShiftUsage, type ShiftUsageScope } from "./inventory.js";

export interface ReassignItemsSummary {
  itemsRemoved: number;
  itemsCreated: number;
  dispositions: number;
  flushedShiftsSkipped: number;
}

interface ItemRow {
  id: string;
  jobId: string | null;
  shiftInstanceId: string | null;
  workcenterId: string | null;
  businessDate: Date | null;
}

/**
 * Items were produced from the old job's products, so they are soft-deleted
 * and recreated from the amended job in one set-based insert (the station
 * lock is held throughout, so this must not scale per cycle). Material staging
 * moves with them for shifts that are still open; a flushed shift's ledger is
 * immutable and is left alone. Scrap logs follow their cycle, or the station
 * within the window when they have none.
 */
export async function reassignItems(ctx: AmendContext, cycleIds: string[]): Promise<ReassignItemsSummary> {
  const { tx, siteId, stationId, from, toEff, job, amendmentId } = ctx;
  const summary: ReassignItemsSummary = { itemsRemoved: 0, itemsCreated: 0, dispositions: 0, flushedShiftsSkipped: 0 };
  if (!job || cycleIds.length === 0) return summary;

  const removed = await tx.$queryRaw<ItemRow[]>`
    UPDATE "InventoryItem" SET "deletedAt" = NOW(), "updatedAt" = NOW()
    WHERE "cycleId" = ANY(${cycleIds}::uuid[]) AND "deletedAt" IS NULL
    RETURNING id, "jobId", "shiftInstanceId", "workcenterId", "businessDate"
  `;
  summary.itemsRemoved = removed.length;

  // Same row shape createFromCycle produces: one item per active JobProduct,
  // quantity = cycle quantity (default 1) × product quantity, dims from the cycle.
  const created = await tx.$queryRaw<ItemRow[]>`
    INSERT INTO "InventoryItem" (id, "cycleId", "jobProductVersionId", "productVersionId", "toolVersionId", "toolCavityVersionId",
      quantity, "quantityUnit", "modeId", "siteId", "stationId", "workcenterId", "jobId", "productId", "toolId",
      "shiftInstanceId", "businessDate", "amendmentId", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), c.id, jp."currentVersionId", p."currentVersionId", t."currentVersionId", tc."currentVersionId",
      (CASE WHEN c.quantity > 0 THEN c.quantity ELSE 1 END) * jpb.quantity, c."quantityUnit", c."modeId",
      c."siteId", c."stationId", c."workcenterId", ${job.id}::uuid, jp."productId", jp."toolId",
      c."shiftInstanceId", c."businessDate", ${amendmentId}::uuid, NOW(), NOW()
    FROM "Cycle" c
    CROSS JOIN "JobProduct" jp
    JOIN "JobProductVersion" jpb ON jpb.id = jp."currentVersionId"
    JOIN "Product" p ON p.id = jp."productId"
    LEFT JOIN "Tool" t ON t.id = jp."toolId"
    LEFT JOIN "ToolCavity" tc ON tc.id = jp."toolCavityId"
    WHERE c.id = ANY(${cycleIds}::uuid[])
      AND jp."jobId" = ${job.id}::uuid AND jp."deletedAt" IS NULL AND jpb."isActive" = true AND jpb.quantity > 0
      AND p."currentVersionId" IS NOT NULL
    RETURNING id, "jobId", "shiftInstanceId", "workcenterId", "businessDate"
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
  summary.flushedShiftsSkipped = flushed.size;

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
        },
        ids: [],
      };
      group.ids.push(it.id);
      groups.set(key, group);
    }
    for (const { scope, ids } of groups.values()) await applyShiftUsage(tx, scope, ids, sign);
  }

  summary.dispositions = await tx.$executeRaw`
    UPDATE "ItemDispositionLog" d
    SET "jobId" = ${job.id}::uuid,
        "jobProductVersionId" = (
          SELECT jp."currentVersionId" FROM "JobProduct" jp
          WHERE jp."jobId" = ${job.id}::uuid AND jp."productId" = d."productId" AND jp."deletedAt" IS NULL
          LIMIT 1
        ),
        "updatedAt" = NOW()
    WHERE d."deletedAt" IS NULL
      AND (
        d."cycleId" = ANY(${cycleIds}::uuid[])
        OR (d."cycleId" IS NULL AND d."stationId" = ${stationId}::uuid
            AND d."createdAt" >= ${from} AND d."createdAt" < ${toEff})
      )
  `;
  return summary;
}

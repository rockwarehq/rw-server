import prisma from "@rw/db";
import { Prisma, type WeightUnit } from "@rw/db";
import { type StampDims, toDateString } from "../facility/work-context.js";
import { convertWeight } from "../lib/units/index.js";

type TransactionClient = Prisma.TransactionClient;

// ============================================================================
// Types
// ============================================================================

export interface ListInventoryFilter {
  siteId?: string;
  cycleId?: string;
  productVersionId?: string;
  jobProductVersionId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Create inventory items for a completed cycle: ONE row per active JobProduct,
 * with quantity = the cycle quantity (stamp.quantity, default 1) × the JobProduct
 * quantity, and the station's unit stamped verbatim. All item accounting
 * downstream is SUM(quantity), never row counts. Accepts a transaction client
 * so cycle-close + inventory creation stay atomic.
 */
/** Star-pattern dimension stamps carried onto every item (and material staging row). */
export interface ItemDims extends StampDims {
  siteId: string;
  stationId: string;
}

export async function createFromCycle(
  tx: TransactionClient,
  cycleId: string,
  jobId: string,
  stamp: { quantity: number | null; quantityUnit: string } | undefined,
  modeId: string | null | undefined,
  dims: ItemDims,
) {
  // Fetch active JobProducts with version refs in a single raw query
  const jobProducts = await (tx as unknown as { $queryRaw: typeof prisma.$queryRaw }).$queryRaw<
    Array<{
      productId: string;
      currentVersionId: string;
      quantity: number;
      productVersionId: string;
      toolId: string | null;
      toolVersionId: string | null;
      toolCavityVersionId: string | null;
      materialVersionIds: string[];
    }>
  >`
    SELECT
      jp."productId",
      jp."currentVersionId",
      COALESCE(jpb.quantity, 1)::int AS quantity,
      p."currentVersionId" AS "productVersionId",
      jp."toolId" AS "toolId",
      t."currentVersionId" AS "toolVersionId",
      tc."currentVersionId" AS "toolCavityVersionId",
      COALESCE(
        (SELECT array_agg(pm."currentVersionId") FILTER (WHERE pm."currentVersionId" IS NOT NULL)
         FROM "ProductMaterial" pm
         JOIN "Material" m ON m.id = pm."materialId"
         LEFT JOIN "ProductMaterialAltGroup" mag ON mag.id = pm."altGroupId"
         WHERE pm."productId" = jp."productId"
           AND pm."archivedAt" IS NULL
           AND m."archivedAt" IS NULL
           AND m."deletedAt" IS NULL
           AND (pm."altGroupId" IS NULL OR mag."activeProductMaterialId" = pm.id)),
        '{}'
      ) AS "materialVersionIds"
    FROM "JobProduct" jp
    JOIN "JobProductVersion" jpb ON jpb.id = jp."currentVersionId"
    JOIN "Product" p ON p.id = jp."productId"
    LEFT JOIN "Tool" t ON t.id = jp."toolId"
    LEFT JOIN "ToolCavity" tc ON tc.id = jp."toolCavityId"
    WHERE jp."jobId" = ${jobId}
      AND jp."deletedAt" IS NULL
      AND jpb."isActive" = true
      AND jp."currentVersionId" IS NOT NULL
      AND p."currentVersionId" IS NOT NULL
  `;

  if (jobProducts.length === 0) {
    return [];
  }

  const txRaw = tx as unknown as { $queryRaw: typeof prisma.$queryRaw; $executeRaw: typeof prisma.$executeRaw };

  // Non-positive product quantities produce nothing (as the old one-row-per-unit loop did).
  const quantity = stamp?.quantity;
  const cycleQuantity = quantity != null && Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  const unit = stamp?.quantityUnit ?? "";
  const itemSpecs = jobProducts
    .filter((jp) => jp.quantity > 0)
    .map((jp) => ({ ...jp, itemQuantity: cycleQuantity * jp.quantity }));

  if (itemSpecs.length === 0) {
    return [];
  }

  // Batch INSERT all inventory items in one query
  const businessDate = toDateString(dims.businessDate) ?? null;
  const insertValues = Prisma.join(
    itemSpecs.map(
      (s) =>
        Prisma.sql`(gen_random_uuid(), ${cycleId}::uuid, ${s.currentVersionId}::uuid, ${s.productVersionId}::uuid, ${s.toolVersionId}::uuid, ${s.toolCavityVersionId}::uuid, ${s.itemQuantity}, ${unit}, ${modeId ?? null}::uuid, ${dims.siteId}::uuid, ${dims.stationId}::uuid, ${dims.workcenterId}::uuid, ${dims.jobId}::uuid, ${s.productId}::uuid, ${s.toolId}::uuid, ${dims.shiftInstanceId}::uuid, ${businessDate}::date, NOW(), NOW())`,
    ),
  );
  const itemRows = await txRaw.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "InventoryItem" (id, "cycleId", "jobProductVersionId", "productVersionId", "toolVersionId", "toolCavityVersionId", quantity, "quantityUnit", "modeId", "siteId", "stationId", "workcenterId", "jobId", "productId", "toolId", "shiftInstanceId", "businessDate", "createdAt", "updatedAt")
    VALUES ${insertValues}
    RETURNING id
  `;

  // Returned shape carries the version refs so downstream in-tx consumers
  // (mode auto-scrap) don't have to re-read the rows just written.
  const createdItems = itemRows.map((row, i) => ({
    id: row.id,
    cycleId,
    productId: itemSpecs[i].productId,
    quantity: itemSpecs[i].itemQuantity,
    productVersionId: itemSpecs[i].productVersionId,
    jobProductVersionId: itemSpecs[i].currentVersionId,
    toolId: itemSpecs[i].toolId,
    toolVersionId: itemSpecs[i].toolVersionId,
    toolCavityVersionId: itemSpecs[i].toolCavityVersionId,
  }));

  // Batch INSERT all material version M2M relations in one query
  const matValues: Prisma.Sql[] = [];
  for (let i = 0; i < itemRows.length; i++) {
    for (const matVersionId of itemSpecs[i].materialVersionIds) {
      matValues.push(Prisma.sql`(${itemRows[i].id}::uuid, ${matVersionId}::uuid)`);
    }
  }
  if (matValues.length > 0) {
    await txRaw.$executeRaw`INSERT INTO "_InventoryItemToProductMaterialVersion" ("A", "B") VALUES ${Prisma.join(matValues)} ON CONFLICT DO NOTHING`;

    // Roll this cycle's material consumption into the staging table.
    //
    // The ledger is append-only and immutable. Active-shift consumption
    // accumulates here in `MaterialShiftUsage`; at shift close,
    // `flushShiftUsage` converts each staging row into one immutable
    // PRODUCTION ledger entry.
    //
    // Cycles without a resolved shift (dims.shiftInstanceId null) are
    // silently skipped.
    if (dims.shiftInstanceId === null) return createdItems;
    const shiftInstanceId = dims.shiftInstanceId;
    const itemIds = itemRows.map((r) => r.id);

    type UsageRow = {
      productId: string;
      materialId: string;
      qty: Prisma.Decimal;
      itemCount: number;
      // Unit declared on the ProductMaterialVersion (how the operator entered weight
      // for this product). May differ from the material's canonical unit.
      pmUnit: WeightUnit | null;
      // Material's canonical/storage unit (from currentVersion). All staging and
      // ledger writes are normalized to this unit.
      materialUnit: WeightUnit | null;
    };
    const want = await txRaw.$queryRaw<UsageRow[]>`
      SELECT
        pb."productId"         AS "productId",
        mb."materialId"        AS "materialId",
        -- weight × quantity: rows carry quantity, not one row per unit
        SUM(pmb.weight * ii.quantity) AS "qty",
        ROUND(SUM(ii.quantity))::int  AS "itemCount",
        pmb."weightUnits"      AS "pmUnit",
        mbc."weightUnits"      AS "materialUnit"
      FROM "_InventoryItemToProductMaterialVersion" x
      JOIN "InventoryItem"        ii  ON ii.id = x."A"
      JOIN "ProductVersion"          pb  ON pb.id = ii."productVersionId"
      JOIN "ProductMaterialVersion"  pmb ON pmb.id = x."B"
      JOIN "MaterialVersion"         mb  ON mb.id = pmb."materialVersionId"
      JOIN "Material"             m   ON m.id  = mb."materialId"
      LEFT JOIN "MaterialVersion"    mbc ON mbc.id = m."currentVersionId"
      WHERE x."A" = ANY(${itemIds}::uuid[])
        AND pmb.weight IS NOT NULL
      GROUP BY pb."productId", mb."materialId", pmb."weightUnits", mbc."weightUnits"
    `;

    if (want.length === 0) return createdItems;

    // For each (shift, station, job, product, material) scope: get-or-create
    // the staging row and bump its quantity + itemCount. Ledger is untouched.
    for (const w of want) {
      const bindingKey = {
        shiftInstanceId_stationId_jobId_productId_materialId: {
          shiftInstanceId,
          stationId: dims.stationId,
          jobId,
          productId: w.productId,
          materialId: w.materialId,
        },
      };

      // Normalize to the material's canonical unit. PM weight may be entered
      // in a different unit (e.g. material stocked in KG, product consumes G);
      // staging and downstream ledger entries are always in the material unit.
      // If the material has no canonical unit, discard the usage — assuming a
      // default would silently mis-stamp ledger entries.
      if (w.materialUnit === null) {
        console.warn(
          `[cycle ${cycleId}] material ${w.materialId} has no weightUnit set; discarding usage qty=${w.qty} for product ${w.productId}`,
        );
        continue;
      }
      const canonicalUnit: WeightUnit = w.materialUnit;
      const pmUnit: WeightUnit = w.pmUnit ?? canonicalUnit;
      const qtyDelta = convertWeight(w.qty, pmUnit, canonicalUnit);

      const existing = await tx.materialShiftUsage.findUnique({
        where: bindingKey,
        select: { id: true, flushedAt: true },
      });

      if (existing) {
        if (existing.flushedAt) {
          // The staging row is already flushed — don't mutate a frozen audit
          // record. This indicates a cycle close happened on a closed shift,
          // which shouldn't occur in normal flow but might via replay/import.
          // Loud, not silent — surface it.
          console.warn(
            `[cycle ${cycleId}] staging row ${existing.id} for shift=${shiftInstanceId} already flushed; skipping increment`,
          );
          continue;
        }
        await tx.materialShiftUsage.update({
          where: { id: existing.id },
          data: {
            quantity: { increment: qtyDelta },
            itemCount: { increment: w.itemCount },
          },
        });
      } else {
        await tx.materialShiftUsage.create({
          data: {
            siteId: dims.siteId,
            shiftInstanceId,
            stationId: dims.stationId,
            workcenterId: dims.workcenterId,
            businessDate: dims.businessDate,
            jobId,
            productId: w.productId,
            materialId: w.materialId,
            quantity: qtyDelta,
            unit: canonicalUnit,
            itemCount: w.itemCount,
          },
        });
      }
    }
  }

  return createdItems;
}

// ============================================================================
// Query Operations
// ============================================================================

/**
 * List inventory items with optional filtering
 */
export async function list(filter: ListInventoryFilter = {}) {
  const { siteId, cycleId, productVersionId, jobProductVersionId, dateFrom, dateTo, limit = 50, offset = 0 } = filter;

  const where: Prisma.InventoryItemWhereInput = {
    deletedAt: null,
  };

  if (cycleId) {
    where.cycleId = cycleId;
  }

  if (productVersionId) {
    where.productVersionId = productVersionId;
  }

  if (jobProductVersionId) {
    where.jobProductVersionId = jobProductVersionId;
  }

  // Filter by site through the cycle -> site relation
  if (siteId) {
    where.cycle = {
      siteId,
    };
  }

  // Date range filter
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) {
      where.createdAt.gte = dateFrom;
    }
    if (dateTo) {
      where.createdAt.lte = dateTo;
    }
  }

  const [items, total] = await Promise.all([
    prisma.inventoryItem.findMany({
      where,
      include: {
        cycle: {
          select: {
            id: true,
            cycleStatus: true,
            start: true,
            end: true,
            order: {
              select: {
                id: true,
                orderNumber: true,
              },
            },
          },
        },
        productVersion: {
          select: {
            id: true,
            version: true,
            sku: true,
            name: true,
          },
        },
        jobProductVersion: {
          select: {
            id: true,
            version: true,
            isActive: true,
          },
        },
        toolVersion: {
          select: {
            id: true,
            version: true,
            name: true,
          },
        },
        toolCavityVersion: {
          select: {
            id: true,
            version: true,
            name: true,
            position: true,
          },
        },
        productMaterialVersions: {
          select: {
            id: true,
            version: true,
            weight: true,
            weightUnits: true,
            itemCost: true,
            materialVersion: {
              select: {
                id: true,
                version: true,
                name: true,
                materialNumber: true,
                shortCode: true,
              },
            },
          },
        },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { createdAt: "desc" },
    }),
    prisma.inventoryItem.count({ where }),
  ]);

  return {
    data: items,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get inventory item by ID with full version details
 */
export async function getById(id: string) {
  const item = await prisma.inventoryItem.findUnique({
    where: { id },
    include: {
      cycle: {
        select: {
          id: true,
          cycleStatus: true,
          start: true,
          end: true,
          site: {
            select: { id: true, name: true },
          },
          order: {
            select: {
              id: true,
              orderNumber: true,
              job: {
                select: {
                  id: true,
                },
              },
            },
          },
        },
      },
      productVersion: true,
      jobProductVersion: true,
      toolVersion: true,
      toolCavityVersion: true,
      productMaterialVersions: {
        include: {
          materialVersion: true,
        },
      },
    },
  });

  if (!item) {
    return null;
  }

  if (item.deletedAt) {
    return { error: "Inventory item has been deleted", code: "INVENTORY_ITEM_DELETED" };
  }

  return { data: item };
}

/**
 * Get all inventory items from a specific cycle
 */
export async function getByCycle(cycleId: string) {
  // Verify cycle exists
  const cycle = await prisma.cycle.findUnique({
    where: { id: cycleId },
    select: {
      id: true,
      cycleStatus: true,
      start: true,
      end: true,
      site: {
        select: { id: true, name: true },
      },
      order: {
        select: {
          id: true,
          orderNumber: true,
          job: {
            select: {
              id: true,
            },
          },
        },
      },
    },
  });

  if (!cycle) {
    return { error: "Cycle not found", code: "CYCLE_NOT_FOUND" };
  }

  const items = await prisma.inventoryItem.findMany({
    where: {
      cycleId,
      deletedAt: null,
    },
    include: {
      productVersion: {
        select: {
          id: true,
          version: true,
          sku: true,
          name: true,
        },
      },
      jobProductVersion: {
        select: {
          id: true,
          version: true,
          isActive: true,
        },
      },
      toolVersion: {
        select: {
          id: true,
          version: true,
          name: true,
        },
      },
      toolCavityVersion: {
        select: {
          id: true,
          version: true,
          name: true,
          position: true,
        },
      },
      productMaterialVersions: {
        select: {
          id: true,
          version: true,
          weight: true,
          weightUnits: true,
          itemCost: true,
          materialVersion: {
            select: {
              id: true,
              version: true,
              name: true,
              materialNumber: true,
              shortCode: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return {
    data: {
      cycle,
      items,
      count: items.length,
    },
  };
}

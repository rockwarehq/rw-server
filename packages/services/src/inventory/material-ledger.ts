import prisma from "@rw/db";
import { Prisma, type MaterialLedgerKind, type WeightUnit } from "@rw/db";
import { publishEntityEvent } from "../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../entity/registry.js";
import { resolveShiftStamp } from "../facility/work-context.js";
import { convertWeight } from "../lib/units/index.js";
import { lockMaterialBalance, pendingMaterialUsage } from "../stock/balance.js";
import { postSources } from "../stock/post.js";

/** Post-commit refresh hint: ledger writes change the material's on-hand stock. */
export function publishStockEvent(siteId: string, workspaceId: string, materialId: string): void {
  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Material,
    entityId: materialId,
    siteId,
    workspaceId,
    changedFields: ["stock"],
  });
}

/**
 * Lock the material's stock row, then read its catalog unit. A unit change
 * (material.update) takes the same lock, so the unit read here holds for the
 * rest of the save. `unit` null means the material is not tracked.
 */
async function lockTrackedMaterial(tx: Prisma.TransactionClient, materialId: string) {
  const stock = await lockMaterialBalance(tx, materialId);
  const current = await tx.material.findUnique({
    where: { id: materialId },
    select: { currentVersion: { select: { weightUnits: true } } },
  });
  return { stock, unit: current?.currentVersion?.weightUnits ?? null };
}

export interface CreateLedgerEntryInput {
  siteId: string;
  materialId: string;
  kind: MaterialLedgerKind;
  quantity: number | string;
  unit: WeightUnit;
  unitCost?: number | string | null;
  reference?: string | null;
  note?: string | null;
  performedByUserId?: string | null;
}

export interface ListLedgerEntriesFilter {
  siteId?: string;
  materialId?: string;
  kind?: MaterialLedgerKind;
  limit?: number;
  offset?: number;
}

const ledgerInclude = {
  material: {
    select: {
      id: true,
      siteId: true,
      currentVersion: {
        select: { materialNumber: true, name: true, shortCode: true },
      },
    },
  },
  performedByUser: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
} satisfies Prisma.MaterialLedgerEntryInclude;

export async function create(input: CreateLedgerEntryInput) {
  const material = await prisma.material.findUnique({
    where: { id: input.materialId },
    select: {
      id: true,
      siteId: true,
      deletedAt: true,
      currentVersion: { select: { weightUnits: true } },
      site: { select: { workspaceId: true } },
    },
  });

  if (!material || material.deletedAt) {
    return { error: "Material not found", code: "MATERIAL_NOT_FOUND" };
  }

  if (material.siteId !== input.siteId) {
    return { error: "Material does not belong to the given site", code: "SITE_MISMATCH" };
  }

  // A material with no stock unit is not tracked: stock actions are refused
  // (ADR-0016). A tracked material takes any weight; the entry keeps the unit
  // it was written in and the stock book converts it to the material's unit.
  if (!material.currentVersion?.weightUnits) {
    return {
      error: "Material stock is not tracked; set its unit before recording stock",
      code: "NO_CANONICAL_UNIT",
    };
  }

  const qty = new Prisma.Decimal(input.quantity);
  if (qty.isZero()) {
    return { error: "Quantity must be non-zero", code: "INVALID_QUANTITY" };
  }

  // Outflow kinds must be recorded as negative; inflows must be positive.
  // ADJUSTMENT accepts signed values.
  const outflowKinds: MaterialLedgerKind[] = ["WRITE_OFF", "TRANSFER_OUT"];
  const inflowKinds: MaterialLedgerKind[] = ["RECEIPT", "TRANSFER_IN", "OPENING_BALANCE"];
  if (outflowKinds.includes(input.kind) && qty.isPositive()) {
    return { error: `${input.kind} quantity must be negative`, code: "INVALID_SIGN" };
  }
  if (inflowKinds.includes(input.kind) && qty.isNegative()) {
    return { error: `${input.kind} quantity must be positive`, code: "INVALID_SIGN" };
  }

  // Star-pattern stamps: the site-level shift running when the event lands
  // (calendar-date fallback when none — e.g. workcenter-scheduled sites).
  const stamp = await resolveShiftStamp(input.siteId, null, new Date());

  // The ledger row and its stock movement are saved together.
  const entry = await prisma.$transaction(async (tx) => {
    // Checked again under the material's stock lock: the unit can only change
    // (or be removed) under this same lock, so it cannot change mid-save.
    const { unit: trackedUnit } = await lockTrackedMaterial(tx, input.materialId);
    if (!trackedUnit) return null;
    const created = await tx.materialLedgerEntry.create({
      data: {
        siteId: input.siteId,
        materialId: input.materialId,
        kind: input.kind,
        quantity: qty,
        unit: input.unit,
        unitCost: input.unitCost != null ? new Prisma.Decimal(input.unitCost) : null,
        reference: input.reference ?? null,
        note: input.note ?? null,
        performedByUserId: input.performedByUserId ?? null,
        ...stamp,
      },
      include: ledgerInclude,
    });
    await postSources(tx, [{ type: "MATERIAL_LEDGER_ENTRY", ids: [created.id] }]);
    return created;
  });
  if (!entry) {
    return {
      error: "Material stock is not tracked; set its unit before recording stock",
      code: "NO_CANONICAL_UNIT",
    };
  }

  publishStockEvent(input.siteId, material.site.workspaceId, input.materialId);

  return { data: entry };
}

export interface AdjustMaterialStockInput {
  siteId: string;
  materialId: string;
  reference?: string | null;
  note?: string | null;
  performedByUserId?: string | null;
}

export type AdjustMaterialStockMode =
  | { mode: "set"; countedQuantity: number | string }
  | { mode: "delta"; delta: number | string };

/**
 * Manually adjust or reconcile a material's on-hand balance (the stock
 * reconciliation counterpart to ProductStockAdjustment). Appends an immutable
 * signed ADJUSTMENT ledger entry and posts it to the stock book; "set" mode
 * computes the delta against the TRUE current balance (stock book minus
 * unflushed shift usage) with the material's stock row locked, so a count
 * lands exactly on the counted value. A zero-delta count is recorded (audit
 * evidence); a zero manual delta is rejected.
 */
export async function adjust(input: AdjustMaterialStockInput & AdjustMaterialStockMode) {
  const material = await prisma.material.findUnique({
    where: { id: input.materialId },
    select: {
      id: true,
      siteId: true,
      deletedAt: true,
      currentVersion: { select: { weightUnits: true } },
      site: { select: { workspaceId: true } },
    },
  });

  if (!material || material.deletedAt) {
    return { error: "Material not found", code: "MATERIAL_NOT_FOUND" };
  }
  if (material.siteId !== input.siteId) {
    return { error: "Material does not belong to the given site", code: "SITE_MISMATCH" };
  }
  const unit = material.currentVersion?.weightUnits ?? null;
  if (!unit) {
    return { error: "Material has no canonical unit; set one before adjusting stock", code: "NO_CANONICAL_UNIT" };
  }

  let requested: Prisma.Decimal;
  if (input.mode === "set") {
    requested = new Prisma.Decimal(input.countedQuantity);
    if (requested.isNegative()) {
      return { error: "Counted quantity cannot be negative", code: "INVALID_QUANTITY" };
    }
  } else {
    requested = new Prisma.Decimal(input.delta);
    if (requested.isZero()) {
      return { error: "Adjustment delta must be non-zero", code: "INVALID_QUANTITY" };
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    // Lock the material's stock row: concurrent counts, entries, unit changes
    // and the end-of-shift flush all wait here, so the count lands exactly.
    const { stock, unit: countUnit } = await lockTrackedMaterial(tx, input.materialId);
    if (!countUnit) return null;

    // True current balance, in the unit the count is given in (the material's
    // unit): the stock book minus what open shifts have used so far (not in
    // the book until the flush).
    const onHand = stock.baseUnit ? convertWeight(stock.onHand, stock.baseUnit as WeightUnit, countUnit) : stock.onHand;
    const pending = await pendingMaterialUsage(tx, input.materialId, countUnit);
    const currentBalance = onHand.minus(pending);

    const delta = input.mode === "set" ? requested.minus(currentBalance) : requested;

    const stamp = await resolveShiftStamp(input.siteId, null, new Date(), tx);

    // A count that matched is still recorded on the ledger (audit evidence);
    // it adds nothing to the stock book.
    const entry = await tx.materialLedgerEntry.create({
      data: {
        siteId: input.siteId,
        materialId: input.materialId,
        kind: "ADJUSTMENT",
        quantity: delta,
        unit: countUnit,
        reference: input.reference ?? null,
        note: input.note ?? null,
        performedByUserId: input.performedByUserId ?? null,
        ...stamp,
      },
      include: ledgerInclude,
    });
    await postSources(tx, [{ type: "MATERIAL_LEDGER_ENTRY", ids: [entry.id] }]);

    return { entry, delta, resultingBalance: currentBalance.plus(delta) };
  });

  if (!result) {
    return { error: "Material has no canonical unit; set one before adjusting stock", code: "NO_CANONICAL_UNIT" };
  }
  if (!result.delta.isZero()) {
    publishStockEvent(input.siteId, material.site.workspaceId, input.materialId);
  }

  return { data: { entry: result.entry, resultingBalance: result.resultingBalance.toString() } };
}

export async function list(filter: ListLedgerEntriesFilter = {}) {
  const { siteId, materialId, kind, limit = 50, offset = 0 } = filter;

  const where: Prisma.MaterialLedgerEntryWhereInput = {};
  if (siteId) where.siteId = siteId;
  if (materialId) where.materialId = materialId;
  if (kind) where.kind = kind;

  const [entries, total] = await Promise.all([
    prisma.materialLedgerEntry.findMany({
      where,
      include: ledgerInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    prisma.materialLedgerEntry.count({ where }),
  ]);

  // Running balance per entry: every ledger row for the same material with
  // createdAt/id <= this entry, each converted to the material's stock unit
  // (rows keep the unit they were written in, which can differ). One query
  // per material on the page, scoped by the (materialId, createdAt) index.
  const balanceByEntryId = new Map<string, string>();
  if (entries.length > 0) {
    const idsByMaterial = new Map<string, string[]>();
    for (const e of entries) {
      const arr = idsByMaterial.get(e.materialId) ?? [];
      arr.push(e.id);
      idsByMaterial.set(e.materialId, arr);
    }
    await Promise.all(
      Array.from(idsByMaterial.entries()).map(async ([mid, ids]) => {
        const rows = await prisma.$queryRaw<Array<{ id: string; runningBalance: Prisma.Decimal }>>`
          SELECT
            target.id,
            COALESCE(SUM(stock_convert(le.quantity, le.unit::text, COALESCE(si."baseUnit", ''))), 0) AS "runningBalance"
          FROM "MaterialLedgerEntry" target
          LEFT JOIN "StockItem" si ON si."stockableType" = 'MATERIAL' AND si."stockableId" = target."materialId"
          LEFT JOIN "MaterialLedgerEntry" le
            ON le."materialId" = target."materialId"
           AND (le."createdAt" < target."createdAt"
             OR (le."createdAt" = target."createdAt" AND le.id <= target.id))
          WHERE target."materialId" = ${mid}::uuid
            AND target.id = ANY(${ids}::uuid[])
          GROUP BY target.id
        `;
        for (const r of rows) balanceByEntryId.set(r.id, r.runningBalance.toString());
      }),
    );
  }

  return {
    data: entries.map((e) => ({ ...e, runningBalance: balanceByEntryId.get(e.id) ?? "0" })),
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

export interface UsageQueryInput {
  siteId: string;
  workCenterId?: string;
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD inclusive
  groupByJob: boolean;
  groupByProduct: boolean;
  jobId?: string;
  productId?: string;
  materialId?: string;
  sortBy?: string;
  sortDir: "asc" | "desc";
  limit: number;
  offset: number;
}

export interface UsageRow {
  businessDate: string;
  shiftName: string | null;
  jobId: string | null;
  jobName: string | null;
  productId: string | null;
  partName: string | null;
  materialId: string;
  materialName: string;
  weightUnits: WeightUnit | null;
  totalWeight: number;
  itemCount: number;
}

const USAGE_SORT_COLUMNS: Record<string, string> = {
  businessDate: '"businessDate"',
  shiftName: '"shiftName"',
  jobName: '"jobName"',
  partName: '"partName"',
  materialName: '"materialName"',
  weightUnits: '"weightUnits"',
  totalWeight: '"totalWeight"',
  itemCount: '"itemCount"',
};

/**
 * Aggregated material consumption rows for the Material Usage / Part Material
 * Usage logs. Reads MaterialShiftUsage (one row per shift × station × job ×
 * product × material; quantity stored positive as the amount consumed) and
 * groups up to the requested dimensions. Includes both unflushed (live) and
 * flushed staging rows — flush is an internal accounting detail, not a UX
 * concept.
 *
 * Cycles closed before the staging table shipped have no MaterialShiftUsage
 * rows and won't appear here — the legacy logs.materialUsageSearch endpoint
 * remains for historical reads.
 */
export async function usage(input: UsageQueryInput): Promise<{ data: UsageRow[]; total: number }> {
  // Resolve workcenter scope (if any) into a station ID list.
  let stationFilter: Prisma.Sql = Prisma.empty;
  if (input.workCenterId) {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true },
    });
    if (stations.length === 0) return { data: [], total: 0 };
    stationFilter = Prisma.sql`AND msu."stationId" = ANY(${stations.map((s) => s.id)}::uuid[])`;
  }

  const startDate = input.startDate ?? "2000-01-01";
  const endDateExclusive = (() => {
    if (!input.endDate) return "2100-01-01";
    const d = new Date(input.endDate);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();

  const jobFilter = input.jobId ? Prisma.sql`AND msu."jobId" = ${input.jobId}::uuid` : Prisma.empty;
  const productFilter = input.productId ? Prisma.sql`AND msu."productId" = ${input.productId}::uuid` : Prisma.empty;
  const materialFilter = input.materialId ? Prisma.sql`AND msu."materialId" = ${input.materialId}::uuid` : Prisma.empty;

  // Conditional grouping: when not grouping by a dimension, project NULL and
  // omit it from GROUP BY so rows collapse across that dimension.
  const jobIdCol: Prisma.Sql = input.groupByJob ? Prisma.sql`br."jobId"` : Prisma.sql`NULL::uuid`;
  const productIdCol: Prisma.Sql = input.groupByProduct ? Prisma.sql`br."productId"` : Prisma.sql`NULL::uuid`;

  const groupCols: Prisma.Sql[] = [Prisma.sql`br."businessDate"`, Prisma.sql`br."shiftName"`];
  if (input.groupByJob) groupCols.push(Prisma.sql`br."jobId"`);
  if (input.groupByProduct) groupCols.push(Prisma.sql`br."productId"`);
  groupCols.push(Prisma.sql`br."materialId"`, Prisma.sql`br."weightUnits"`);
  const groupByClause = Prisma.join(groupCols, ", ");

  const sortColumn = (input.sortBy && USAGE_SORT_COLUMNS[input.sortBy]) || USAGE_SORT_COLUMNS.businessDate;
  const sortDir = input.sortDir === "asc" ? Prisma.raw("ASC") : Prisma.raw("DESC");
  const orderBy = Prisma.sql`ORDER BY ${Prisma.raw(sortColumn)} ${sortDir} NULLS LAST`;

  const limit = Number(input.limit);
  const offset = Number(input.offset);
  const limitClause: Prisma.Sql = limit > 0 ? Prisma.sql`LIMIT ${limit} OFFSET ${offset}` : Prisma.empty;

  const rows = await prisma.$queryRaw<Array<UsageRow & { totalCount: bigint }>>`
    WITH binding_rows AS (
      SELECT
        si."businessDate"::date AS "businessDate",
        si."shiftName"          AS "shiftName",
        msu."jobId"             AS "jobId",
        msu."productId"         AS "productId",
        msu."materialId"        AS "materialId",
        msu."unit"              AS "weightUnits",
        msu."quantity"          AS "weight",
        msu."itemCount"         AS "itemCount"
      FROM "MaterialShiftUsage" msu
      JOIN "ShiftInstance"       si ON si.id = msu."shiftInstanceId"
      WHERE msu."siteId" = ${input.siteId}::uuid
        AND si."businessDate" >= ${startDate}::date
        AND si."businessDate" <  ${endDateExclusive}::date
        ${stationFilter}
        ${jobFilter}
        ${productFilter}
        ${materialFilter}
    ),
    grouped AS (
      SELECT
        br."businessDate" AS "businessDate",
        br."shiftName"    AS "shiftName",
        ${jobIdCol}       AS "jobId",
        ${productIdCol}   AS "productId",
        br."materialId"   AS "materialId",
        br."weightUnits"  AS "weightUnits",
        SUM(br."weight")     AS "totalWeight",
        SUM(br."itemCount")  AS "itemCount"
      FROM binding_rows br
      GROUP BY ${groupByClause}
    ),
    decorated AS (
      SELECT
        to_char(g."businessDate", 'YYYY-MM-DD')      AS "businessDate",
        g."shiftName"                                AS "shiftName",
        g."jobId"                                    AS "jobId",
        jb.name                                      AS "jobName",
        g."productId"                                AS "productId",
        pb.name                                      AS "partName",
        g."materialId"                               AS "materialId",
        COALESCE(mb.name, '—')                       AS "materialName",
        g."weightUnits"                              AS "weightUnits",
        ROUND(g."totalWeight"::numeric, 2)::float8   AS "totalWeight",
        g."itemCount"::int                           AS "itemCount"
      FROM grouped g
      LEFT JOIN "Job"          j  ON j.id  = g."jobId"
      LEFT JOIN "JobVersion"      jb ON jb.id = j."currentVersionId"
      LEFT JOIN "Product"      p  ON p.id  = g."productId"
      LEFT JOIN "ProductVersion"  pb ON pb.id = p."currentVersionId"
      LEFT JOIN "Material"     m  ON m.id  = g."materialId"
      LEFT JOIN "MaterialVersion" mb ON mb.id = m."currentVersionId"
    )
    SELECT
      d.*,
      COUNT(*) OVER () AS "totalCount"
    FROM decorated d
    ${orderBy}
    ${limitClause}
  `;

  const total = rows.length > 0 ? Number(rows[0].totalCount) : 0;
  const data: UsageRow[] = rows.map(({ totalCount: _ignored, ...rest }) => rest);
  return { data, total };
}

export async function getById(id: string) {
  const entry = await prisma.materialLedgerEntry.findUnique({
    where: { id },
    include: ledgerInclude,
  });

  if (!entry) {
    return { error: "Ledger entry not found", code: "LEDGER_ENTRY_NOT_FOUND" };
  }

  return { data: entry };
}

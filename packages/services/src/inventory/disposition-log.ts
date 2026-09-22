import prisma, { Prisma } from "@rw/db";
import { updateDispositionBadItems } from "@rw/services/metrics/recalc";
import { publishEntityEvent } from "../entity/events.js";
import { publishUiChange } from "../events/ui-changes.js";
import { SYSTEM_ENTITY_KEYS } from "../entity/registry.js";
import { resolveShiftStamp, toDateString } from "../facility/work-context.js";
import { applyScrapDelta } from "./stock.js";

/** Post-commit refresh hint: dispositions change the product's on-hand stock. */
function publishStockEvent(siteId: string, workspaceId: string, productId: string): void {
  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Product,
    entityId: productId,
    siteId,
    workspaceId,
    changedFields: ["stock"],
  });
}

export interface CreateDispositionLogInput {
  siteId: string;
  stationId: string;
  workcenterId?: string;
  quantity?: number;
  itemDispositionId?: string;
  dispositionReasonId?: string;
  cycleId?: string;
  shiftInstanceId?: string;
  /** Star-pattern stamps paired with the version snapshots below. */
  jobId?: string;
  toolId?: string;
  /** If not provided, version IDs are auto-resolved from current station/job state */
  productVersionId: string;
  stationVersionId?: string;
  jobProductVersionId?: string;
  toolVersionId?: string;
  toolCavityVersionId?: string;
  productMaterialVersionIds?: string[];
}

export interface UpdateDispositionLogInput {
  quantity?: number;
  itemDispositionId?: string | null;
  dispositionReasonId?: string | null;
}

export interface ListDispositionLogsFilter {
  siteId?: string;
  stationId?: string;
  shiftInstanceId?: string;
  dispositionReasonId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

const logInclude = {
  station: { select: { id: true, name: true } },
  itemDisposition: { select: { id: true, name: true } },
  dispositionReason: { select: { id: true, name: true } },
  productVersion: { select: { id: true, version: true, name: true, sku: true } },
  stationVersion: { select: { id: true, version: true } },
  toolVersion: { select: { id: true, version: true, name: true } },
  toolCavityVersion: { select: { id: true, version: true, name: true } },
  jobProductVersion: { select: { id: true, version: true } },
  productMaterialVersions: {
    select: {
      id: true,
      version: true,
      weight: true,
      weightUnits: true,
      itemCost: true,
      materialVersion: {
        select: { id: true, version: true, name: true, materialNumber: true, shortCode: true },
      },
    },
  },
  shiftInstance: { select: { id: true, shiftName: true, businessDate: true, startTime: true, endTime: true } },
  cycle: { select: { id: true } },
};

type DispositionLogRecord = Prisma.ItemDispositionLogGetPayload<{ include: typeof logInclude }>;
type ServiceError = { error: string; code: string };

// Extended include for list — resolves entity IDs from versions for UI aggregation
const logListInclude = {
  ...logInclude,
  productVersion: { select: { id: true, version: true, name: true, sku: true, productId: true } },
  toolCavityVersion: { select: { id: true, version: true, name: true, toolCavityId: true } },
  jobProductVersion: { select: { id: true, version: true, jobProduct: { select: { jobId: true } } } },
};

export interface RecordDispositionLogInput {
  siteId: string;
  stationId: string;
  workcenterId?: string;
  productId: string;
  jobId?: string;
  toolCavityId?: string;
  quantity?: number;
  itemDispositionId?: string;
  dispositionReasonId?: string;
  cycleId?: string;
  shiftInstanceId?: string;
}

export async function validateDispositionReasonPair(
  siteId: string,
  itemDispositionId: string | null | undefined,
  dispositionReasonId: string | null | undefined,
  stationId?: string,
): Promise<
  { error: string; code: string } | { data: { itemDispositionId: string | null; dispositionReasonId: string | null } }
> {
  if (!itemDispositionId && !dispositionReasonId) {
    return { data: { itemDispositionId: null, dispositionReasonId: null } };
  }

  if (!itemDispositionId || !dispositionReasonId) {
    return {
      error: "Disposition and disposition reason are required together",
      code: "DISPOSITION_PAIR_REQUIRED",
    };
  }

  const disposition = await prisma.itemDisposition.findUnique({
    where: { id: itemDispositionId },
    select: { id: true, siteId: true, deletedAt: true },
  });

  if (!disposition || disposition.deletedAt) {
    return { error: "Disposition not found", code: "DISPOSITION_NOT_FOUND" };
  }

  if (disposition.siteId !== siteId) {
    return { error: "Disposition must belong to the same site", code: "SITE_MISMATCH" };
  }

  const reason = await prisma.itemDispositionReason.findUnique({
    where: { id: dispositionReasonId },
    select: {
      id: true,
      siteId: true,
      deletedAt: true,
      labels: { select: { id: true } },
      itemDispositions: {
        where: { id: itemDispositionId },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!reason || reason.deletedAt) {
    return { error: "Disposition reason not found", code: "DISPOSITION_REASON_NOT_FOUND" };
  }

  if (reason.siteId !== siteId) {
    return { error: "Disposition reason must belong to the same site", code: "SITE_MISMATCH" };
  }

  if (reason.itemDispositions.length === 0) {
    return {
      error: "Disposition reason is not linked to this disposition",
      code: "DISPOSITION_REASON_NOT_LINKED",
    };
  }

  // If the station filters scrap codes, the reason must pass the filter.
  if (stationId) {
    const stationFilter = await prisma.labelFilter.findUnique({
      where: { stationId_target: { stationId, target: "DISPOSITION_REASON" } },
      select: { labels: { select: { id: true } } },
    });
    // An empty filter (only possible via direct DB writes) is ignored.
    if (stationFilter && stationFilter.labels.length > 0) {
      const allowed = new Set(stationFilter.labels.map((l) => l.id));
      if (!reason.labels.some((l) => allowed.has(l.id))) {
        return {
          error: "The station's scrap-code filter does not allow this reason",
          code: "LABEL_FILTER_MISMATCH",
        };
      }
    }
  }

  return { data: { itemDispositionId, dispositionReasonId } };
}

/**
 * Create a disposition log entry from entity IDs, auto-resolving
 * the current version snapshots for station, product, jobProduct,
 * tool, and toolCavity.
 */
export async function record(input: RecordDispositionLogInput): Promise<ServiceError | { data: DispositionLogRecord }> {
  const { siteId, stationId, productId, jobId, toolCavityId, ...passthrough } = input;

  // Resolve station → stationVersionId
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: { id: true, siteId: true, currentVersionId: true },
  });

  if (!station) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }
  if (station.siteId !== siteId) {
    return { error: "Station must belong to the specified site", code: "SITE_MISMATCH" };
  }

  // Resolve product → productVersionId and product material version IDs
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      currentVersionId: true,
      deletedAt: true,
      materials: {
        select: { currentVersionId: true },
      },
    },
  });

  if (!product || product.deletedAt) {
    return { error: "Product not found", code: "PRODUCT_NOT_FOUND" };
  }
  if (!product.currentVersionId) {
    return { error: "Product has no current version version", code: "NO_CURRENT_VERSION" };
  }

  // Resolve jobProduct → jobProductVersionId (if jobId provided)
  let jobProductVersionId: string | undefined;
  if (jobId) {
    const jobProduct = await prisma.jobProduct.findFirst({
      where: { jobId, productId, deletedAt: null },
      select: { currentVersionId: true },
    });

    if (!jobProduct) {
      return { error: "JobProduct not found for given job and product", code: "JOB_PRODUCT_NOT_FOUND" };
    }
    if (!jobProduct.currentVersionId) {
      return { error: "JobProduct has no current version version", code: "NO_CURRENT_VERSION" };
    }
    jobProductVersionId = jobProduct.currentVersionId;
  }

  // Resolve toolCavity → toolCavityVersionId + toolVersionId (if provided)
  let toolCavityVersionId: string | undefined;
  let toolVersionId: string | undefined;
  let toolId: string | undefined;
  if (toolCavityId) {
    const toolCavity = await prisma.toolCavity.findUnique({
      where: { id: toolCavityId },
      select: {
        currentVersionId: true,
        deletedAt: true,
        toolId: true,
        tool: { select: { currentVersionId: true } },
      },
    });

    if (!toolCavity || toolCavity.deletedAt) {
      return { error: "Tool cavity not found", code: "TOOL_CAVITY_NOT_FOUND" };
    }
    if (!toolCavity.currentVersionId) {
      return { error: "Tool cavity has no current version version", code: "NO_CURRENT_VERSION" };
    }
    toolCavityVersionId = toolCavity.currentVersionId;
    toolVersionId = toolCavity.tool.currentVersionId ?? undefined;
    toolId = toolCavity.toolId;
  }

  // Resolve product material version IDs
  const productMaterialVersionIds = product.materials
    .map((pm) => pm.currentVersionId)
    .filter((id): id is string => id != null);

  const result = await create({
    siteId,
    stationId,
    jobId,
    toolId,
    productVersionId: product.currentVersionId,
    stationVersionId: station.currentVersionId ?? undefined,
    jobProductVersionId,
    toolVersionId,
    toolCavityVersionId,
    productMaterialVersionIds,
    ...passthrough,
  });

  // The stock scrap delta is applied inside create() (via the resolved
  // productVersion), so this wrapper must not apply it again.
  return result;
}

export async function create(input: CreateDispositionLogInput): Promise<ServiceError | { data: DispositionLogRecord }> {
  const {
    siteId,
    stationId,
    quantity,
    itemDispositionId,
    dispositionReasonId,
    cycleId,
    shiftInstanceId,
    jobId,
    toolId,
    productVersionId,
    stationVersionId,
    jobProductVersionId,
    toolVersionId,
    toolCavityVersionId,
    productMaterialVersionIds,
  } = input;

  // Validate station exists and belongs to site
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: { id: true, siteId: true, workcenterId: true, site: { select: { workspaceId: true } } },
  });

  if (!station) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }

  if (station.siteId !== siteId) {
    return { error: "Station must belong to the specified site", code: "SITE_MISMATCH" };
  }

  const dispositionPair = await validateDispositionReasonPair(
    siteId,
    itemDispositionId,
    dispositionReasonId,
    stationId,
  );
  if ("error" in dispositionPair) {
    return dispositionPair;
  }

  // Validate productVersion exists and resolve productId for order deduction
  const productVersion = await prisma.productVersion.findUnique({
    where: { id: productVersionId },
    select: { id: true, productId: true },
  });

  if (!productVersion) {
    return { error: "Product version not found", code: "PRODUCT_VERSION_NOT_FOUND" };
  }

  // Star-pattern stamps: an explicit shiftInstanceId (backdated entry) wins and
  // supplies the business date; otherwise resolve the shift running now.
  const workcenterId = input.workcenterId ?? station.workcenterId ?? null;
  let shiftId: string | null = shiftInstanceId ?? null;
  let businessDate: Date | null = null;
  let isScheduled = true;
  if (shiftId) {
    const instance = await prisma.shiftInstance.findUnique({
      where: { id: shiftId },
      select: { businessDate: true, isScheduled: true },
    });
    businessDate = instance?.businessDate ?? null;
    isScheduled = instance?.isScheduled ?? true;
  } else {
    const stamp = await resolveShiftStamp(siteId, workcenterId, new Date());
    shiftId = stamp.shiftInstanceId;
    businessDate = stamp.businessDate;
    isScheduled = stamp.isScheduled;
  }

  // Stable ids paired with the version snapshots: derive from the versions
  // when the caller didn't pass them, so rpc callers that only know version
  // ids still produce fully-stamped rows.
  let stampJobId = jobId ?? null;
  if (!stampJobId && jobProductVersionId) {
    const jpv = await prisma.jobProductVersion.findUnique({
      where: { id: jobProductVersionId },
      select: { jobProduct: { select: { jobId: true } } },
    });
    stampJobId = jpv?.jobProduct.jobId ?? null;
  }
  let stampToolId = toolId ?? null;
  if (!stampToolId && toolVersionId) {
    const tv = await prisma.toolVersion.findUnique({
      where: { id: toolVersionId },
      select: { toolId: true },
    });
    stampToolId = tv?.toolId ?? null;
  }

  // Log write + stock scrap delta stay atomic: scrap only ever affects
  // inventory (never orders), and the aggregate must match the fact.
  const log = await prisma.$transaction(async (tx) => {
    const created = await tx.itemDispositionLog.create({
      data: {
        siteId,
        stationId,
        workcenterId,
        quantity: quantity ?? 1,
        itemDispositionId: dispositionPair.data.itemDispositionId,
        dispositionReasonId: dispositionPair.data.dispositionReasonId,
        cycleId: cycleId ?? null,
        shiftInstanceId: shiftId,
        businessDate,
        isScheduled,
        jobId: stampJobId,
        productId: productVersion.productId,
        toolId: stampToolId,
        productVersionId,
        stationVersionId: stationVersionId ?? null,
        jobProductVersionId: jobProductVersionId ?? null,
        toolVersionId: toolVersionId ?? null,
        toolCavityVersionId: toolCavityVersionId ?? null,
        productMaterialVersions:
          productMaterialVersionIds && productMaterialVersionIds.length > 0
            ? { connect: productMaterialVersionIds.map((id) => ({ id })) }
            : undefined,
      },
      include: logInclude,
    });
    await applyScrapDelta(tx, siteId, productVersion.productId, quantity ?? 1);
    return created;
  });

  // Trigger metric recalculation for badItems
  updateDispositionBadItems(stationId, siteId, log.createdAt, quantity ?? 1)
    .then(() => publishUiChange({ kind: "scrap.recorded", siteId, stationId }))
    .catch((err) => {
      console.error(`[disposition-log] Failed to update badItems metrics for station ${stationId}:`, err);
    });

  publishStockEvent(siteId, station.site.workspaceId, productVersion.productId);

  return { data: log };
}

/**
 * Bulk-scrap freshly created cycle items (production-mode scrapAll): one log
 * row per inventory item, inside the caller's cycle transaction. Version
 * snapshots come from the items themselves; the badItems metric bump is the
 * caller's post-commit responsibility. Returns the total scrapped quantity.
 */
export async function autoScrapCycleItems(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    stationId: string;
    modeId: string;
    itemDispositionId: string;
    dispositionReasonId: string;
    // Star-pattern stamps, resolved once by the cycle path.
    workcenterId: string | null;
    jobId: string;
    shiftInstanceId: string | null;
    businessDate: Date | null;
    items: Array<{
      id: string;
      cycleId: string;
      productId: string;
      quantity: number;
      productVersionId: string;
      jobProductVersionId: string | null;
      toolId: string | null;
      toolVersionId: string | null;
      toolCavityVersionId: string | null;
    }>;
  },
): Promise<number> {
  if (input.items.length === 0) return 0;

  const station = await tx.station.findUniqueOrThrow({
    where: { id: input.stationId },
    select: { currentVersionId: true },
  });

  const businessDate = toDateString(input.businessDate) ?? null;
  const values = Prisma.join(
    input.items.map(
      (item) =>
        Prisma.sql`(gen_random_uuid(), ${item.quantity}, ${input.siteId}::uuid, ${input.stationId}::uuid, ${input.workcenterId}::uuid, ${item.cycleId}::uuid, ${input.shiftInstanceId}::uuid, ${businessDate}::date, ${input.jobId}::uuid, ${item.productId}::uuid, ${item.toolId}::uuid, ${input.itemDispositionId}::uuid, ${input.dispositionReasonId}::uuid, ${item.productVersionId}::uuid, ${station.currentVersionId}::uuid, ${item.jobProductVersionId}::uuid, ${item.toolVersionId}::uuid, ${item.toolCavityVersionId}::uuid, ${input.modeId}::uuid, NOW(), NOW())`,
    ),
  );
  await tx.$executeRaw`
    INSERT INTO "ItemDispositionLog"
      (id, quantity, "siteId", "stationId", "workcenterId", "cycleId", "shiftInstanceId",
       "businessDate", "jobId", "productId", "toolId",
       "itemDispositionId", "dispositionReasonId", "productVersionId", "stationVersionId",
       "jobProductVersionId", "toolVersionId", "toolCavityVersionId", "modeId", "createdAt", "updatedAt")
    VALUES ${values}
  `;

  const perProduct = new Map<string, number>();
  for (const item of input.items) {
    perProduct.set(item.productId, (perProduct.get(item.productId) ?? 0) + item.quantity);
  }
  let total = 0;
  // Sorted by productId: applyProduction and completeOrder both take their
  // ProductStock row locks in that order, and a Map iterates in insertion
  // order. Scrapping two products in the opposite order to a concurrent
  // cycle or completion is an ABBA deadlock — and the cycle path runs this
  // and applyProduction in the same transaction.
  for (const productId of [...perProduct.keys()].sort()) {
    const qty = perProduct.get(productId) ?? 0;
    if (qty === 0) continue;
    await applyScrapDelta(tx, input.siteId, productId, qty);
    total += qty;
  }
  return total;
}

export async function list(filter: ListDispositionLogsFilter = {}) {
  const {
    siteId,
    stationId,
    shiftInstanceId,
    dispositionReasonId,
    startDate,
    endDate,
    limit = 50,
    offset = 0,
  } = filter;

  const where: Record<string, unknown> = { deletedAt: null };

  if (siteId) where.siteId = siteId;
  if (stationId) where.stationId = stationId;
  if (shiftInstanceId) where.shiftInstanceId = shiftInstanceId;
  if (dispositionReasonId) where.dispositionReasonId = dispositionReasonId;

  if (startDate || endDate) {
    const createdAt: Record<string, unknown> = {};
    if (startDate) createdAt.gte = startDate;
    if (endDate) createdAt.lte = endDate;
    where.createdAt = createdAt;
  }

  const [logs, total] = await Promise.all([
    prisma.itemDispositionLog.findMany({
      where,
      include: logListInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { createdAt: "desc" },
    }),
    prisma.itemDispositionLog.count({ where }),
  ]);

  return {
    data: logs,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

export async function getById(id: string) {
  const log = await prisma.itemDispositionLog.findUnique({
    where: { id },
    include: logInclude,
  });

  if (!log || log.deletedAt) {
    return null;
  }

  return { data: log };
}

export async function update(
  id: string,
  input: UpdateDispositionLogInput,
): Promise<ServiceError | { data: DispositionLogRecord }> {
  const { quantity, itemDispositionId, dispositionReasonId } = input;

  const current = await prisma.itemDispositionLog.findUnique({
    where: { id },
    select: {
      id: true,
      siteId: true,
      stationId: true,
      deletedAt: true,
      quantity: true,
      itemDispositionId: true,
      dispositionReasonId: true,
      site: { select: { workspaceId: true } },
      productVersion: { select: { productId: true } },
    },
  });

  if (!current || current.deletedAt) {
    return { error: "Disposition log not found", code: "DISPOSITION_LOG_NOT_FOUND" };
  }

  const currentQuantity = Number(current.quantity);
  const nextItemDispositionId = itemDispositionId !== undefined ? itemDispositionId : current.itemDispositionId;
  const nextDispositionReasonId = dispositionReasonId !== undefined ? dispositionReasonId : current.dispositionReasonId;
  const dispositionPair = await validateDispositionReasonPair(
    current.siteId,
    nextItemDispositionId,
    nextDispositionReasonId,
    current.stationId,
  );
  if ("error" in dispositionPair) {
    return dispositionPair;
  }

  const updateData: Record<string, unknown> = {};
  if (quantity !== undefined) updateData.quantity = quantity;
  if (itemDispositionId !== undefined) updateData.itemDispositionId = itemDispositionId;
  if (dispositionReasonId !== undefined) updateData.dispositionReasonId = dispositionReasonId;

  const quantityDelta = quantity !== undefined ? quantity - currentQuantity : 0;

  const log = await prisma.$transaction(async (tx) => {
    const updated = await tx.itemDispositionLog.update({
      where: { id },
      data: updateData,
      include: logInclude,
    });
    if (quantityDelta !== 0) {
      await applyScrapDelta(tx, current.siteId, current.productVersion.productId, quantityDelta);
    }
    return updated;
  });

  // If quantity changed, trigger metric recalc with delta
  if (quantityDelta !== 0) {
    updateDispositionBadItems(current.stationId, current.siteId, log.createdAt, quantityDelta)
      .then(() => publishUiChange({ kind: "scrap.recorded", siteId: current.siteId, stationId: current.stationId }))
      .catch((err) => {
        console.error(`[disposition-log] Failed to update badItems metrics for station ${current.stationId}:`, err);
      });
    publishStockEvent(current.siteId, current.site.workspaceId, current.productVersion.productId);
  }

  return { data: log };
}

export async function remove(id: string) {
  const log = await prisma.itemDispositionLog.findUnique({
    where: { id },
    select: {
      id: true,
      stationId: true,
      siteId: true,
      quantity: true,
      deletedAt: true,
      createdAt: true,
      site: { select: { workspaceId: true } },
      productVersion: { select: { productId: true } },
    },
  });

  if (!log || log.deletedAt) {
    return { error: "Disposition log not found", code: "DISPOSITION_LOG_NOT_FOUND" };
  }

  await prisma.$transaction(async (tx) => {
    await tx.itemDispositionLog.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await applyScrapDelta(tx, log.siteId, log.productVersion.productId, -Number(log.quantity));
  });

  // Subtract the removed quantity from metrics
  updateDispositionBadItems(log.stationId, log.siteId, log.createdAt, -Number(log.quantity))
    .then(() => publishUiChange({ kind: "scrap.recorded", siteId: log.siteId, stationId: log.stationId }))
    .catch((err) => {
      console.error(`[disposition-log] Failed to update badItems metrics for station ${log.stationId}:`, err);
    });

  publishStockEvent(log.siteId, log.site.workspaceId, log.productVersion.productId);

  return { success: true };
}

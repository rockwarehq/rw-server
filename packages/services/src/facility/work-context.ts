import type { RefSource } from "@rw/automations";
import prisma from "@rw/db";

// Resolves "where did this happen" for domain events: the running shift for a station's work
// center (falling back to the site-wide shift), and the flat WorkContext carried on the event.

export interface ShiftContext {
  id: string;
  name: string;
  businessDate: Date;
}

export async function resolveShiftContext(
  siteId: string,
  workcenterId: string | null,
  at: Date,
): Promise<ShiftContext | null> {
  const select = { id: true, shiftName: true, businessDate: true } as const;
  const toContext = (row: { id: string; shiftName: string; businessDate: Date } | null) =>
    row ? { id: row.id, name: row.shiftName, businessDate: row.businessDate } : null;
  if (workcenterId) {
    const scoped = await prisma.shiftInstance.findFirst({
      where: { siteId, workCenterId: workcenterId, startTime: { lte: at }, endTime: { gt: at } },
      select,
      orderBy: { startTime: "desc" },
    });
    if (scoped) return toContext(scoped);
  }
  return toContext(
    await prisma.shiftInstance.findFirst({
      where: { siteId, workCenterId: null, startTime: { lte: at }, endTime: { gt: at } },
      select,
      orderBy: { startTime: "desc" },
    }),
  );
}

export const toDateString = (d: Date | null | undefined) => d?.toISOString().slice(0, 10);

/**
 * BI dimension snapshots from the station's current job. Tool/product are only set when the job
 * has exactly one active tool/product — multi-tool or multi-product jobs dimension through jobId.
 */
export async function resolveJobDimensions(currentJobId: string | null) {
  const empty = {
    jobId: null,
    jobVersionId: null,
    toolId: null,
    toolVersionId: null,
    productId: null,
    productVersionId: null,
  };
  if (!currentJobId) return empty;
  const job = await prisma.job.findUnique({
    where: { id: currentJobId },
    select: {
      id: true,
      currentVersionId: true,
      tools: {
        where: { isActive: true, deletedAt: null },
        select: { toolId: true, tool: { select: { currentVersionId: true } } },
        take: 2,
      },
      jobProducts: {
        where: { deletedAt: null, currentVersion: { isActive: true } },
        select: { productId: true, product: { select: { currentVersionId: true } } },
        take: 2,
      },
    },
  });
  if (!job) return empty;
  const tool = job.tools.length === 1 ? job.tools[0] : null;
  const jobProduct = job.jobProducts.length === 1 ? job.jobProducts[0] : null;
  return {
    jobId: job.id,
    jobVersionId: job.currentVersionId,
    toolId: tool?.toolId ?? null,
    toolVersionId: tool?.tool.currentVersionId ?? null,
    productId: jobProduct?.productId ?? null,
    productVersionId: jobProduct?.product.currentVersionId ?? null,
  };
}

/** The star-pattern dimension columns a shop-floor fact row (Call, StationModeLog) snapshots at creation. */
export async function snapshotDimensions(
  station: {
    siteId: string;
    workcenterId: string | null;
    currentJobId: string | null;
    currentVersionId: string | null;
  },
  at: Date,
) {
  const [shift, jobDims] = await Promise.all([
    resolveShiftContext(station.siteId, station.workcenterId, at),
    resolveJobDimensions(station.currentJobId),
  ]);
  return {
    workcenterId: station.workcenterId,
    stationVersionId: station.currentVersionId,
    ...jobDims,
    shiftInstanceId: shift?.id ?? null,
    businessDate: shift?.businessDate ?? null,
  };
}

/** `shiftNames` picker source — the distinct shift names a site has run ("Shift 1", ...). id = name. */
export const shiftNamesAutomationRef: RefSource = {
  key: "shiftNames",
  async list(ctx) {
    if (typeof ctx.siteId !== "string") return [];
    const rows = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT DISTINCT "shiftName" AS name FROM "ShiftInstance" WHERE "siteId" = ${ctx.siteId}::uuid ORDER BY name
    `;
    return rows.map((r) => ({ id: r.name, label: r.name }));
  },
};

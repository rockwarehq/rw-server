import prisma from "@rw/db";
import { getStock } from "../inventory/stock.js";

// ============================================================================
// Coverage — read-time FIFO matching of available stock to open-order demand
// ============================================================================
//
// Nothing is stored: coverage is a pure projection of (ProductStock.available,
// open-order queue ordered by sequence). Consumption happens only at order
// completion. A future scheduling module overrides this default by partitioning
// `available` before the walk — the API shape stays unchanged.

export interface LineItemCoverage {
  coveredQuantity: number;
  remainingQuantity: number;
}

export interface CoverageResult {
  /** Coverage per OrderLineItem id, for every line in the site's open queue carrying the requested products. */
  byLineItem: Map<string, LineItemCoverage>;
  /** Open-queue demand per product (sum of targetQuantity). */
  openDemand: Map<string, number>;
  /** How much of that demand current stock covers, FIFO by queue position. */
  coveredDemand: Map<string, number>;
  /** Available stock per product (before the walk). */
  available: Map<string, number>;
}

/**
 * Compute FIFO coverage for all OPEN/IN_PROGRESS orders in the site that carry
 * any of the given products. The whole queue is walked (not just one page of
 * orders) because a row's coverage depends on the orders ahead of it.
 * Two queries total, independent of caller page size.
 */
export async function computeCoverage(siteId: string, productIds: string[]): Promise<CoverageResult> {
  const result: CoverageResult = {
    byLineItem: new Map(),
    openDemand: new Map(),
    coveredDemand: new Map(),
    available: new Map(),
  };
  if (productIds.length === 0) return result;

  const stock = await getStock(prisma, siteId, productIds);

  const queue = await prisma.$queryRaw<Array<{ lineItemId: string; productId: string; target: number }>>`
    SELECT oli.id AS "lineItemId", oli."productId", oli."targetQuantity"::float8 AS target
    FROM "OrderLineItem" oli
    JOIN "Order" o ON o.id = oli."orderId"
    WHERE o."siteId" = ${siteId}::uuid
      AND o.status IN ('OPEN', 'IN_PROGRESS')
      AND o."deletedAt" IS NULL
      AND oli."productId" = ANY(${productIds}::uuid[])
    ORDER BY o.sequence ASC NULLS LAST, o."createdAt" ASC, oli."createdAt" ASC
  `;

  const remaining = new Map<string, number>();
  for (const productId of productIds) {
    const available = stock.get(productId)?.available ?? 0;
    remaining.set(productId, available);
    result.available.set(productId, available);
    result.openDemand.set(productId, 0);
    result.coveredDemand.set(productId, 0);
  }

  for (const line of queue) {
    const left = remaining.get(line.productId) ?? 0;
    const covered = Math.min(left, line.target);
    remaining.set(line.productId, left - covered);
    result.byLineItem.set(line.lineItemId, {
      coveredQuantity: covered,
      remainingQuantity: Math.max(line.target - covered, 0),
    });
    result.openDemand.set(line.productId, (result.openDemand.get(line.productId) ?? 0) + line.target);
    result.coveredDemand.set(line.productId, (result.coveredDemand.get(line.productId) ?? 0) + covered);
  }

  return result;
}

/** Statuses whose orders sit in the coverage queue. */
export function isQueueStatus(status: string): boolean {
  return status === "OPEN" || status === "IN_PROGRESS";
}

/**
 * Per-product stock summary for product pages and pickers: the ProductStock
 * columns plus open-order demand and how much of it current stock covers.
 */
export async function getProductStockSummary(siteId: string, productIds: string[]) {
  const stock = await getStock(prisma, siteId, productIds);
  const coverage = await computeCoverage(siteId, productIds);
  return {
    data: productIds.map((productId) => {
      const row = stock.get(productId);
      return {
        productId,
        produced: row?.produced ?? 0,
        scrapped: row?.scrapped ?? 0,
        consumed: row?.consumed ?? 0,
        adjustment: row?.adjustment ?? 0,
        available: row?.available ?? 0,
        openDemand: coverage.openDemand.get(productId) ?? 0,
        coveredDemand: coverage.coveredDemand.get(productId) ?? 0,
      };
    }),
  };
}

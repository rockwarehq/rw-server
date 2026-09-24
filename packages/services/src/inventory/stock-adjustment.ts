import prisma from "@rw/db";
import { Prisma, type StockAdjustmentReason } from "@rw/db";
import { publishEntityEvent } from "../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../entity/registry.js";
import { resolveShiftStamp } from "../facility/work-context.js";
import { checkAutoComplete } from "../order/auto-complete.js";
import { lockProductBalances } from "../stock/balance.js";
import { postSources } from "../stock/post.js";
import { getStock } from "./stock.js";

// ============================================================================
// Product stock adjustments — manual on-hand reconciliation
// ============================================================================
//
// Append-only book of record: each adjustment is one immutable signed delta,
// posted to the stock book (StockMovement, ADR-0016) in the same transaction. Two entry modes: "set" reconciles to a counted on-hand value
// (the delta is computed against the RAW unclamped on-hand under a row lock,
// so the count lands exactly — even when raw is negative from over-scrap);
// "delta" applies a signed correction directly.

export type AdjustStockInput = {
  siteId: string;
  productId: string;
  reason: StockAdjustmentReason;
  note?: string | null;
  performedByUserId?: string | null;
} & ({ mode: "set"; countedQuantity: number | string } | { mode: "delta"; delta: number | string });

export interface ListStockAdjustmentsFilter {
  siteId?: string;
  productId?: string;
  limit?: number;
  offset?: number;
}

const adjustmentInclude = {
  performedByUser: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
} satisfies Prisma.ProductStockAdjustmentInclude;

export async function adjustStock(input: AdjustStockInput) {
  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: { id: true, siteId: true, deletedAt: true, site: { select: { workspaceId: true } } },
  });

  if (!product || product.deletedAt) {
    return { error: "Product not found", code: "PRODUCT_NOT_FOUND" };
  }
  if (product.siteId !== input.siteId) {
    return { error: "Product does not belong to the given site", code: "SITE_MISMATCH" };
  }

  let requested: Prisma.Decimal;
  if (input.mode === "set") {
    requested = new Prisma.Decimal(input.countedQuantity);
    if (requested.isNegative()) {
      return { error: "Counted quantity cannot be negative", code: "INVALID_QUANTITY" };
    }
  } else {
    requested = new Prisma.Decimal(input.delta);
    // A zero manual delta is a client mistake; a zero-delta COUNT (set mode)
    // is meaningful audit evidence ("counted, matched") and is allowed.
    if (requested.isZero()) {
      return { error: "Adjustment delta must be non-zero", code: "INVALID_QUANTITY" };
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    // Lock this product's stock row. One row, no other locks taken — cannot
    // block cycle saves or order completion in a circle.
    const onHand = await lockProductBalances(tx, input.siteId, [input.productId]);
    const rawOnHand = onHand.get(input.productId) ?? new Prisma.Decimal(0);

    const delta = input.mode === "set" ? requested.minus(rawOnHand) : requested;
    const resultingOnHand = rawOnHand.plus(delta);

    // Star-pattern stamps: the site-level shift running when the adjustment lands
    // (calendar-date fallback when none — e.g. workcenter-scheduled sites).
    const stamp = await resolveShiftStamp(input.siteId, null, new Date(), tx);

    const entry = await tx.productStockAdjustment.create({
      data: {
        siteId: input.siteId,
        productId: input.productId,
        delta,
        resultingOnHand,
        reason: input.reason,
        note: input.note ?? null,
        performedByUserId: input.performedByUserId ?? null,
        ...stamp,
      },
      include: adjustmentInclude,
    });
    // A count that matched adds nothing to the stock book; the adjustment row
    // is the record that it happened.
    await postSources(tx, [{ type: "PRODUCT_STOCK_ADJUSTMENT", ids: [entry.id] }]);

    const stock = await getStock(tx, input.siteId, [input.productId]);
    return { entry, stock: stock.get(input.productId), delta };
  });

  // Post-commit side effects — never inside the tx, fire-and-forget.
  if (!result.delta.isZero()) {
    publishEntityEvent({
      action: "updated",
      entityKey: SYSTEM_ENTITY_KEYS.Product,
      entityId: input.productId,
      siteId: input.siteId,
      workspaceId: product.site.workspaceId,
      changedFields: ["stock"],
    });
  }
  if (result.delta.isPositive()) {
    // Upward moves can newly cover open orders.
    checkAutoComplete(input.siteId, [input.productId]).catch((err) => {
      console.error(`[stock-adjustment] auto-complete check failed for site ${input.siteId}:`, err);
    });
  }

  return { data: { entry: result.entry, stock: result.stock } };
}

export async function list(filter: ListStockAdjustmentsFilter = {}) {
  const { siteId, productId, limit = 50, offset = 0 } = filter;

  const where: Prisma.ProductStockAdjustmentWhereInput = {};
  if (siteId) where.siteId = siteId;
  if (productId) where.productId = productId;

  const [entries, total] = await Promise.all([
    prisma.productStockAdjustment.findMany({
      where,
      include: adjustmentInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    prisma.productStockAdjustment.count({ where }),
  ]);

  return { data: entries, total, limit: Number(limit), offset: Number(offset) };
}

import prisma from "@rw/db";
import { Prisma, type StockAdjustmentReason } from "@rw/db";
import { publishEntityEvent } from "../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../entity/registry.js";
import { checkAutoComplete } from "../order/auto-complete.js";
import { getStock } from "./stock.js";

// ============================================================================
// Product stock adjustments — manual on-hand reconciliation
// ============================================================================
//
// Append-only book of record mirroring the material ledger: each adjustment is
// one immutable signed delta, applied to ProductStock.adjustment in the same
// transaction. Two entry modes: "set" reconciles to a counted on-hand value
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
    const txRaw = tx as unknown as { $queryRaw: typeof prisma.$queryRaw; $executeRaw: typeof prisma.$executeRaw };

    // Ensure the aggregate row exists, then lock it. Single-row lock with no
    // further lock acquisition — cannot deadlock against applyProduction /
    // completeOrder (both lock in sorted productId order).
    await txRaw.$executeRaw`
      INSERT INTO "ProductStock" ("siteId", "productId", "updatedAt")
      VALUES (${input.siteId}::uuid, ${input.productId}::uuid, NOW())
      ON CONFLICT ("siteId", "productId") DO NOTHING
    `;
    const rows = await txRaw.$queryRaw<Array<{ raw: string }>>`
      SELECT (produced - scrapped - consumed + adjustment)::text AS raw
      FROM "ProductStock"
      WHERE "siteId" = ${input.siteId}::uuid AND "productId" = ${input.productId}::uuid
      FOR UPDATE
    `;
    const rawOnHand = new Prisma.Decimal(rows[0]?.raw ?? 0);

    const delta = input.mode === "set" ? requested.minus(rawOnHand) : requested;
    const resultingOnHand = rawOnHand.plus(delta);

    if (!delta.isZero()) {
      await tx.productStock.update({
        where: { siteId_productId: { siteId: input.siteId, productId: input.productId } },
        data: { adjustment: { increment: delta } },
      });
    }

    const entry = await tx.productStockAdjustment.create({
      data: {
        siteId: input.siteId,
        productId: input.productId,
        delta,
        resultingOnHand,
        reason: input.reason,
        note: input.note ?? null,
        performedByUserId: input.performedByUserId ?? null,
      },
      include: adjustmentInclude,
    });

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

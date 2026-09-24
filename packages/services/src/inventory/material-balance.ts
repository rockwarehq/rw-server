import prisma from "@rw/db";
import { Prisma, type WeightUnit } from "@rw/db";
import { getMaterialStock, pendingMaterialUsage } from "../stock/balance.js";

export interface MaterialBalance {
  materialId: string;
  /** The material's stock unit (from its current MaterialVersion); null = not tracked. */
  unit: WeightUnit | null;
  /** Sum of RECEIPT + TRANSFER_IN + OPENING_BALANCE ledger entries. */
  received: Prisma.Decimal;
  /** Net signed sum of ADJUSTMENT entries. */
  adjusted: Prisma.Decimal;
  /** Total consumed: WRITE_OFF + TRANSFER_OUT + end-of-shift usage, plus what open shifts have used so far. */
  consumed: Prisma.Decimal;
  /** received + adjusted − consumed. */
  balance: Prisma.Decimal;
  /** If the caller passed `asOf`, echoed here; otherwise null. */
  asOf: Date | null;
}

/**
 * Compute a material's on-hand balance, in its stock unit.
 *
 * Balance has two sources:
 *   1. The stock book (StockBalance, built from StockMovement, ADR-0016):
 *      every material ledger row, converted to the material's unit —
 *      receipts, adjustments, write-offs, transfers, and the end-of-shift
 *      usage.
 *   2. `MaterialShiftUsage` (unflushed) — what open shifts have used so far,
 *      not in the book until the shift is flushed.
 *
 * Open-shift usage counts as consumption-in-progress, so it is subtracted.
 *
 * `asOf` adds the book up to that moment instead of reading the saved
 * totals. The open-shift side is "right now" by definition.
 */
export async function balance(materialId: string, asOf?: Date): Promise<MaterialBalance> {
  const material = await prisma.material.findUnique({
    where: { id: materialId },
    select: { currentVersion: { select: { weightUnits: true } } },
  });
  const unit = material?.currentVersion?.weightUnits ?? null;
  const zero = new Prisma.Decimal(0);

  const stock = await getMaterialStock(materialId, asOf ?? null);
  const pending = await pendingMaterialUsage(prisma, materialId, stock?.baseUnit ?? unit ?? "");

  const received = stock?.received ?? zero;
  const adjusted = stock?.adjusted ?? zero;
  const issued = stock?.issued ?? zero;
  const onHand = stock?.onHand ?? zero;

  return {
    materialId,
    unit,
    received,
    adjusted,
    consumed: issued.plus(pending),
    balance: onHand.minus(pending),
    asOf: asOf ?? null,
  };
}

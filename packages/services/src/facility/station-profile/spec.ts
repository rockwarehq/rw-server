import type { Prisma } from "@rw/db";
import type { CycleModeValue } from "../../cycle/standards.js";
import type { RatePeriod } from "../../lib/units/quantity.js";
import { decimalToNumber } from "../../metrics/sync.js";
import type { CountedAs, ProfileSpec, VariationSpec } from "./rules.js";

export type ProfileRow = Prisma.StationProfileGetPayload<object>;
export type VariationRow = Prisma.StationProfileVariationGetPayload<object>;
export type ProfileWithVariations = ProfileRow & { variations: VariationRow[] };

/** The live variations of a profile, in page order. Include with `variations: LIVE_VARIATIONS`. */
export const LIVE_VARIATIONS = {
  where: { archivedAt: null },
  orderBy: [{ position: "asc" }, { createdAt: "asc" }],
} satisfies Prisma.StationProfile$variationsArgs;

/** A variation row with its Decimal columns as plain numbers. */
export function toVariationSpec(row: VariationRow): VariationSpec & { id: string } {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    signalAmount: decimalToNumber(row.signalAmount),
    signalInterval: decimalToNumber(row.signalInterval),
  };
}

/**
 * A profile row with its Decimal columns as plain numbers, carrying one
 * variation's signal fields (none given: no signal fields, which is all a
 * job needs — how it counts, its unit and its usual speed).
 */
export function toSpec(row: ProfileRow, variation?: VariationRow | null): ProfileSpec {
  return {
    cycleMode: row.cycleMode as CycleModeValue,
    quantityUnit: row.quantityUnit,
    signalAmount: variation ? decimalToNumber(variation.signalAmount) : null,
    signalInterval: variation ? decimalToNumber(variation.signalInterval) : null,
    countedAs: row.countedAs as CountedAs,
    standardCycle: decimalToNumber(row.standardCycle),
    standardRate: decimalToNumber(row.standardRate),
    standardRateUnit: row.standardRateUnit,
    standardRatePeriod: row.standardRatePeriod as RatePeriod,
  };
}

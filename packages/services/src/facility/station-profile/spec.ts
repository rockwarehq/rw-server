import type { Prisma } from "@rw/db";
import type { CycleModeValue } from "../../cycle/standards.js";
import type { RatePeriod } from "../../lib/units/quantity.js";
import { decimalToNumber } from "../../metrics/sync.js";
import type { CountedAs, ProfileSpec } from "./rules.js";

export type ProfileRow = Prisma.StationProfileGetPayload<object>;

/** A profile row with its Decimal columns as plain numbers. */
export function toSpec(row: ProfileRow): ProfileSpec {
  return {
    cycleMode: row.cycleMode as CycleModeValue,
    quantityUnit: row.quantityUnit,
    signalAmount: decimalToNumber(row.signalAmount),
    signalInterval: decimalToNumber(row.signalInterval),
    countedAs: row.countedAs as CountedAs,
    standardCycle: decimalToNumber(row.standardCycle),
    standardRate: decimalToNumber(row.standardRate),
    standardRateUnit: row.standardRateUnit,
    standardRatePeriod: row.standardRatePeriod as RatePeriod,
  };
}

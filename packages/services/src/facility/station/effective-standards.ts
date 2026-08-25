import type prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { resolveStandards, type ResolvedStandards } from "../../cycle/standards.js";
import { decimalToNumber } from "../../metrics/sync.js";

type Client = Prisma.TransactionClient | typeof prisma;

/**
 * Resolve the effective standards for a station+job pairing from the CURRENT
 * station and job versions; callers snapshot the result (StationJobLog at
 * assignment, Cycle at record time). DISCRETE resolves to the job's entered
 * standardCycle — unchanged behavior.
 */
export async function resolveEffectiveStandards(
  client: Client,
  stationId: string,
  jobId: string,
): Promise<ResolvedStandards> {
  const [stationVersion, jobVersion] = await Promise.all([
    client.stationVersion.findFirst({
      where: { station: { id: stationId }, currentOfStation: { isNot: null } },
      select: {
        cycleMode: true,
        standardQuantity: true,
        quantityUnit: true,
        standardCycle: true,
        standardRate: true,
        standardRateUnit: true,
        standardRatePeriod: true,
      },
    }),
    client.jobVersion.findFirst({
      where: { job: { id: jobId }, currentOfJob: { isNot: null } },
      select: {
        standardCycle: true,
        standardRate: true,
        standardRateUnit: true,
        standardRatePeriod: true,
        standardQuantity: true,
      },
    }),
  ]);

  return resolveStandards({
    cycleMode: stationVersion?.cycleMode,
    stationStandardQuantity: decimalToNumber(stationVersion?.standardQuantity ?? null),
    stationQuantityUnit: stationVersion?.quantityUnit,
    stationStandardCycle: decimalToNumber(stationVersion?.standardCycle ?? null),
    stationStandardRate: decimalToNumber(stationVersion?.standardRate ?? null),
    stationStandardRateUnit: stationVersion?.standardRateUnit,
    stationStandardRatePeriod: stationVersion?.standardRatePeriod,
    jobStandardCycle: decimalToNumber(jobVersion?.standardCycle ?? null),
    jobStandardRate: decimalToNumber(jobVersion?.standardRate ?? null),
    jobStandardRateUnit: jobVersion?.standardRateUnit,
    jobStandardRatePeriod: jobVersion?.standardRatePeriod,
    jobStandardQuantity: decimalToNumber(jobVersion?.standardQuantity ?? null),
  });
}

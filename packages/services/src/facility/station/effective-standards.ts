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
  });
}

/**
 * What a StationJobLog for this pairing carries: the job's current version and
 * the standards resolved from it. Every job log takes these, never a copy of
 * an older log's, so a job edited mid-run cannot leave its target on the old
 * standard. Null when the job has no current version.
 */
export async function currentJobLogStandards(client: Client, stationId: string, jobId: string) {
  const [job, std] = await Promise.all([
    client.job.findUnique({ where: { id: jobId }, select: { currentVersionId: true } }),
    resolveEffectiveStandards(client, stationId, jobId),
  ]);
  if (!job?.currentVersionId) return null;
  return {
    std,
    log: {
      jobVersionId: job.currentVersionId,
      standardCycle: std.standardCycleSeconds,
      standardQuantity: std.standardQuantity,
      quantityUnit: std.quantityUnit,
    },
  };
}

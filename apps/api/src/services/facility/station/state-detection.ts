import prisma from "../../../database/client.js";
import {
  scheduleDetection as enqueueDetection,
  cancelDetection as dequeueDetection,
} from "../../../queues/station-detection.js";

/**
 * Calculate and schedule slow/downtime detection timers for a station.
 *
 * Reads the station's current blob config (slowDetect, downtimeDetect) and
 * the given job's current blob (standardCycle) to compute timer dates.
 *
 * - Slow fires at:  now + standardCycle * (1 + slowDetect) seconds
 * - Down fires at:  now + (standardCycle + downtimeDetect) seconds
 *
 * If the station has no current blob or the job has no standardCycle,
 * detection is skipped (existing timers are still cancelled).
 */
export async function scheduleDetection(stationId: string, jobId: string) {
  // Fetch station blob config and job standard cycle in parallel
  const [stationWithBlob, jobWithBlob] = await Promise.all([
    prisma.stationBlob.findFirst({
      where: {
        station: { id: stationId },
        currentOfStation: { isNot: null },
      },
      select: {
        slowDetect: true,
        slowDetectUnit: true,
        downtimeDetect: true,
        downtimeDetectUnit: true,
      },
    }),
    prisma.jobBlob.findFirst({
      where: {
        job: { id: jobId },
        currentOfJob: { isNot: null },
      },
      select: {
        standardCycle: true,
      },
    }),
  ]);

  const blob = stationWithBlob;
  const standardCycleSeconds = jobWithBlob?.standardCycle ? Number(jobWithBlob.standardCycle) : null;

  // If no config or no standard cycle, cancel any existing timers and bail
  if (!blob || standardCycleSeconds == null || standardCycleSeconds <= 0) {
    await dequeueDetection(stationId);
    return;
  }

  const now = Date.now();

  // Calculate slow start-after date
  // slowDetect is a decimal representing the fraction over standard cycle
  // e.g. 0.5 = 50% over → slow at standardCycle * 1.5
  let slowStartAfter: Date | null = null;
  if (blob.slowDetect != null) {
    const slowFraction = Number(blob.slowDetect);
    if (slowFraction > 0) {
      const delayMs = standardCycleSeconds * (1 + slowFraction) * 1000;
      slowStartAfter = new Date(now + delayMs);
    }
  }

  // Calculate downtime start-after date
  // downtimeDetect is in seconds, added to standardCycle
  // e.g. downtimeDetect=60, standardCycle=60 → down at 120s
  let downStartAfter: Date | null = null;
  if (blob.downtimeDetect != null) {
    const downtimeSeconds = Number(blob.downtimeDetect);
    if (downtimeSeconds > 0) {
      const delayMs = (standardCycleSeconds + downtimeSeconds) * 1000;
      downStartAfter = new Date(now + delayMs);
    }
  }

  await enqueueDetection(stationId, slowStartAfter, downStartAfter);
}

/**
 * Cancel any pending detection timers for a station.
 */
export async function cancelDetection(stationId: string) {
  await dequeueDetection(stationId);
}

import prisma from "@rw/db";
import { toSpec } from "../facility/station-profile/spec.js";
import {
  kindOf,
  kindsMatch,
  planningRate,
  type Speed,
  speedDisplay,
  usesRate,
  validateSpeedShape,
} from "../facility/station-profile/rules.js";
import type { RatePeriod } from "../lib/units/quantity.js";
import { decimalToNumber } from "../metrics/sync.js";

// A job and its profile (ADR-0017). The profile is the kind of machine the
// job is made for; it sets the shape of the job's speed (seconds per cycle,
// or amount per time) and which stations can run it.

export interface JobProfileRequest {
  /** undefined = no change; null = clear (older jobs only). */
  profileId?: string | null;
  standardCycle?: number | null;
  standardRate?: number | null;
  standardRateUnit?: string;
  standardRatePeriod?: RatePeriod;
  standardQuantity?: number | null;
}

type OldVersion = {
  profileId: string | null;
  standardCycle: unknown;
  standardRate: unknown;
  standardRateUnit: string;
  standardRatePeriod: string;
} | null;

export interface JobProfileFields {
  profileId: string | null;
  standardCycle: number | null;
  standardRate: number | null;
  standardRateUnit: string;
  standardRatePeriod: RatePeriod;
  /** A job never sets the amount per signal once it has a profile. */
  standardQuantity: null;
}

/**
 * Work out a job version's profile and speed. Returns null when the job has
 * no profile and asks for none (older jobs keep working as before).
 *  - A new job with no speed of its own starts with the profile's usual speed,
 *    so it has a target from day one (for planning, before any station).
 *  - A job can move to another profile only of the same counting kind: same
 *    way of counting, units of the same kind. Otherwise make a new job.
 */
export async function resolveJobProfileFields(
  siteId: string,
  old: OldVersion,
  req: JobProfileRequest,
): Promise<{ error: string; code: string } | { fields: JobProfileFields } | null> {
  const profileId = req.profileId !== undefined ? req.profileId : (old?.profileId ?? null);
  if (!profileId) {
    if (req.profileId === null && old?.profileId) {
      return { error: "A job's profile can be changed but not removed", code: "PROFILE_REQUIRED" };
    }
    return null;
  }

  const profile = await prisma.stationProfile.findUnique({ where: { id: profileId } });
  if (!profile || profile.siteId !== siteId || (profile.archivedAt && profileId !== old?.profileId)) {
    return { error: "Profile not found", code: "PROFILE_NOT_FOUND" };
  }
  const spec = toSpec(profile);

  if (old?.profileId && old.profileId !== profileId) {
    const prev = await prisma.stationProfile.findUnique({ where: { id: old.profileId } });
    if (prev) {
      const p = toSpec(prev);
      const sameKind = kindsMatch(
        kindOf(p.cycleMode, p.countedAs, p.quantityUnit),
        kindOf(spec.cycleMode, spec.countedAs, spec.quantityUnit),
      );
      if (!sameKind) {
        return {
          error: "This job counts a different way. Make a new job for a different kind of machine.",
          code: "PROFILE_KIND_CHANGE",
        };
      }
    }
  }

  const before: Speed = {
    standardCycle: decimalToNumber((old?.standardCycle ?? null) as never),
    standardRate: decimalToNumber((old?.standardRate ?? null) as never),
    standardRateUnit: old?.standardRateUnit ?? "",
    standardRatePeriod: (old?.standardRatePeriod ?? "MINUTE") as RatePeriod,
  };
  const merged: Speed = {
    standardCycle: req.standardCycle !== undefined ? req.standardCycle : before.standardCycle,
    standardRate: req.standardRate !== undefined ? req.standardRate : before.standardRate,
    standardRateUnit: req.standardRateUnit ?? before.standardRateUnit,
    standardRatePeriod: req.standardRatePeriod ?? before.standardRatePeriod,
  };

  // A brand-new job with no speed starts with the profile's usual speed.
  const hasSpeed = usesRate(spec.cycleMode) ? merged.standardRate != null : merged.standardCycle != null;
  const speedAsked =
    req.standardCycle !== undefined || req.standardRate !== undefined || req.standardRateUnit !== undefined;
  const speed = !old && !hasSpeed && !speedAsked ? { ...spec } : merged;

  const checked = validateSpeedShape(spec.cycleMode, spec.quantityUnit, speed);
  if ("error" in checked) return checked;
  return { fields: { profileId, ...checked.data, standardQuantity: null } };
}

/**
 * A job's planning numbers with no station picked: its own speed, or the
 * profile's usual speed, and what that makes per hour given its products.
 */
export async function planning(jobId: string) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      deletedAt: true,
      currentVersion: { include: { profile: true } },
      jobProducts: {
        where: { deletedAt: null },
        select: { currentVersion: { select: { isActive: true, quantity: true } } },
      },
    },
  });
  if (!job || job.deletedAt) return { error: "Job not found", code: "JOB_NOT_FOUND" };
  const version = job.currentVersion;
  if (!version?.profile) return { data: { profile: null, speedDisplay: null, rate: null } };

  const spec = toSpec(version.profile);
  const partsPerCount = job.jobProducts
    .filter((p) => p.currentVersion?.isActive)
    .reduce((sum, p) => sum + (p.currentVersion?.quantity ?? 0), 0);
  const rate = planningRate(
    spec,
    {
      standardCycle: decimalToNumber(version.standardCycle),
      standardRate: decimalToNumber(version.standardRate),
      standardRateUnit: version.standardRateUnit,
      standardRatePeriod: version.standardRatePeriod as RatePeriod,
    },
    partsPerCount,
  );
  return {
    data: {
      profile: { id: version.profile.id, name: version.profile.name, ...spec },
      speedDisplay: speedDisplay(spec),
      partsPerCount: partsPerCount > 0 ? partsPerCount : 1,
      rate,
    },
  };
}

/**
 * A machine that reports finished parts on a clock (count by time, OUTPUT)
 * gives one number per report, so it can only go to one product at ×1.
 * `change` is the product line being added or edited; `exceptItemId` is left
 * out of the count when editing.
 */
export async function checkOneOutputRule(
  jobId: string,
  change: { isActive: boolean; quantity: number; exceptItemId?: string },
): Promise<{ error: string; code: string } | null> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      currentVersion: { select: { profile: { select: { cycleMode: true, countedAs: true } } } },
      jobProducts: {
        where: { deletedAt: null, ...(change.exceptItemId ? { id: { not: change.exceptItemId } } : {}) },
        select: { currentVersion: { select: { isActive: true } } },
      },
    },
  });
  const profile = job?.currentVersion?.profile;
  if (!profile || profile.cycleMode !== "QUANTITY_PER_INTERVAL" || profile.countedAs !== "OUTPUT") return null;
  if (!change.isActive) return null;
  const others = job.jobProducts.filter((p) => p.currentVersion?.isActive).length;
  if (others > 0 || change.quantity !== 1) {
    return {
      error: "This machine reports finished parts, so the count goes to one product at ×1.",
      code: "ONE_OUTPUT_PRODUCT",
    };
  }
  return null;
}

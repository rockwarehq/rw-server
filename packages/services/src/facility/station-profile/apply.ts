import prisma from "@rw/db";
import { publishEntityEvent } from "../../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../../entity/registry.js";
import type { RatePeriod } from "../../lib/units/quantity.js";
import { decimalToNumber } from "../../metrics/sync.js";
import { refreshStationStandards } from "../station/state.js";
import { ensureDefaultProfile } from "./default.js";
import { toSpec } from "./spec.js";
import {
  type Speed,
  type StationProfileFields,
  stationFieldsFromProfile,
  usesRate,
  validateSpeedShape,
} from "./rules.js";

// Copy a profile onto the stations that follow it (ADR-0017). Each station
// gets a new StationVersion, the same as any station edit, so history stays
// replayable and the cycle engine keeps reading StationVersion only.

const COPIED = [
  "profileId",
  "cycleMode",
  "quantityUnit",
  "standardQuantity",
  "standardCycle",
  "standardRate",
  "standardRateUnit",
  "standardRatePeriod",
  "speedFromProfile",
] as const;

/** The station's own speed off its version, in the profile's shape. */
export function ownSpeedOf(version: {
  standardCycle: unknown;
  standardRate: unknown;
  standardRateUnit: string;
  standardRatePeriod: string;
}): Speed {
  return {
    standardCycle: decimalToNumber(version.standardCycle as never),
    standardRate: decimalToNumber(version.standardRate as never),
    standardRateUnit: version.standardRateUnit,
    standardRatePeriod: version.standardRatePeriod as RatePeriod,
  };
}

export async function applyProfileToStations(profileId: string): Promise<number> {
  const profile = await prisma.stationProfile.findUnique({ where: { id: profileId } });
  if (!profile) return 0;
  const spec = toSpec(profile);

  const stations = await prisma.station.findMany({
    where: { deletedAt: null, currentVersion: { profileId } },
    select: {
      id: true,
      siteId: true,
      currentJobId: true,
      site: { select: { workspaceId: true } },
      currentVersion: true,
    },
  });

  let changed = 0;
  for (const station of stations) {
    const current = station.currentVersion;
    if (!current) continue;
    // A station with its own speed keeps it; the rest follow the profile.
    // Count by time keeps the station's own rate, never its old interval.
    const fields = stationFieldsFromProfile(profileId, spec, current.speedFromProfile ? null : ownSpeedOf(current));
    const same = COPIED.every((key) => String(fields[key] ?? "") === String(normalizeCurrent(current[key]) ?? ""));
    if (same) continue;

    await prisma.$transaction(async (tx) => {
      const latest = await tx.stationVersion.findFirst({
        where: { stationId: station.id },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const { id: _id, version: _v, createdAt: _c, ...rest } = current;
      const version = await tx.stationVersion.create({
        data: { ...rest, ...fields, version: (latest?.version ?? 0) + 1 },
      });
      await tx.station.update({ where: { id: station.id }, data: { currentVersionId: version.id } });
    });
    changed++;

    publishEntityEvent({
      action: "updated",
      entityKey: SYSTEM_ENTITY_KEYS.Station,
      entityId: station.id,
      siteId: station.siteId,
      workspaceId: station.site.workspaceId,
      changedFields: [...COPIED],
    });
    if (station.currentJobId) {
      await refreshStationStandards(station.id, station.currentJobId, new Date()).catch((err) => {
        console.error(`[stationProfile.apply] refresh failed for station ${station.id}:`, err);
      });
    }
  }
  return changed;
}

/** Decimals compare by their number value. */
function normalizeCurrent(value: unknown): unknown {
  if (value != null && typeof value === "object" && "toNumber" in value) return decimalToNumber(value as never);
  return value;
}

/** What a station create/update asks for, as far as profiles go. */
export interface StationProfileRequest {
  /** undefined = no change; null = stop following a profile (values stay). */
  profileId?: string | null;
  /** true = drop the station's own speed and follow the profile's usual speed. */
  useProfileSpeed?: boolean;
  cycleMode?: string;
  quantityUnit?: string;
  standardQuantity?: number | null;
  standardCycle?: number | null;
  standardRate?: number | null;
  standardRateUnit?: string;
  standardRatePeriod?: RatePeriod;
}

type CurrentVersion = {
  profileId: string | null;
  speedFromProfile: boolean;
  standardCycle: unknown;
  standardRate: unknown;
  standardRateUnit: string;
  standardRatePeriod: string;
} | null;

/**
 * Work out the StationVersion fields a profile sets for this edit. Returns
 * null when profiles are not involved (legacy station edited by hand), a
 * `detach` marker for profileId: null, or the fields to write. A station on a
 * profile may only set its own speed; how it counts comes from the profile.
 */
export async function resolveStationProfileFields(
  siteId: string,
  current: CurrentVersion,
  req: StationProfileRequest,
): Promise<{ error: string; code: string } | { fields: StationProfileFields | { profileId: null } } | null> {
  if (req.profileId === null) return { fields: { profileId: null } };
  let profileId = req.profileId ?? current?.profileId ?? null;
  // A hand-set station taking the default keeps the speed it already has.
  let keepSpeed = false;
  if (!profileId) {
    keepSpeed = !!current;
    // No profile yet: the site's Discrete default — unless an older client is
    // setting another way of counting by hand, which stays a hand-set station.
    if (req.cycleMode !== undefined && req.cycleMode !== "DISCRETE") return null;
    profileId = (await ensureDefaultProfile(siteId)).id;
  }

  const profile = await prisma.stationProfile.findUnique({ where: { id: profileId } });
  if (!profile || profile.archivedAt || profile.siteId !== siteId) {
    return { error: "Profile not found", code: "PROFILE_NOT_FOUND" };
  }
  const spec = toSpec(profile);

  // How the machine counts is the profile's. Values that already match are fine
  // (older clients send the whole form); anything else is refused.
  const fixed = stationFieldsFromProfile(profileId, spec, null);
  const clash =
    (req.cycleMode !== undefined && req.cycleMode !== fixed.cycleMode) ||
    (req.quantityUnit !== undefined && req.quantityUnit !== fixed.quantityUnit) ||
    (req.standardQuantity !== undefined && !sameNumber(req.standardQuantity, fixed.standardQuantity)) ||
    (usesRate(spec.cycleMode) &&
      req.standardCycle !== undefined &&
      !sameNumber(req.standardCycle, fixed.standardCycle));
  if (clash) {
    return {
      error: "This station follows a profile, so how it counts is set on the profile. Only its speed can change here.",
      code: "PROFILE_OWNS_FIELD",
    };
  }

  const speedGiven = usesRate(spec.cycleMode)
    ? req.standardRate !== undefined || req.standardRateUnit !== undefined || req.standardRatePeriod !== undefined
    : req.standardCycle !== undefined;
  const switching = profileId !== (current?.profileId ?? null);

  let ownSpeed: Speed | null;
  if (req.useProfileSpeed) {
    ownSpeed = null;
  } else if (speedGiven) {
    const base: Speed = current && !switching && !current.speedFromProfile ? ownSpeedOf(current) : { ...spec };
    const merged: Speed = {
      standardCycle: req.standardCycle !== undefined ? req.standardCycle : base.standardCycle,
      standardRate: req.standardRate !== undefined ? req.standardRate : base.standardRate,
      standardRateUnit: req.standardRateUnit ?? base.standardRateUnit,
      standardRatePeriod: req.standardRatePeriod ?? base.standardRatePeriod,
    };
    const checked = validateSpeedShape(spec.cycleMode, spec.quantityUnit, merged);
    if ("error" in checked) return checked;
    const hasSpeed = usesRate(spec.cycleMode) ? checked.data.standardRate != null : checked.data.standardCycle != null;
    // Clearing the station's speed means "follow the profile".
    ownSpeed = hasSpeed ? checked.data : null;
  } else if (keepSpeed && current && hasOwnSpeed(spec.cycleMode, ownSpeedOf(current))) {
    ownSpeed = ownSpeedOf(current);
  } else if (switching || !current || current.speedFromProfile) {
    ownSpeed = null;
  } else {
    ownSpeed = ownSpeedOf(current);
  }

  return { fields: stationFieldsFromProfile(profileId, spec, ownSpeed) };
}

function hasOwnSpeed(mode: string, speed: Speed): boolean {
  return mode === "DISCRETE" ? speed.standardCycle != null : speed.standardRate != null;
}

function sameNumber(a: number | null | undefined, b: number | null): boolean {
  return (a ?? null) === b || (a != null && b != null && Math.abs(a - b) < 1e-9);
}

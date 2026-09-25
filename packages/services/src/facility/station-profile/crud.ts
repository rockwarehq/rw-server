import prisma, { Prisma } from "@rw/db";
import type { CycleModeValue } from "../../cycle/standards.js";
import type { RatePeriod } from "../../lib/units/quantity.js";
import { applyProfileToStations } from "./apply.js";
import { type ProfileRow, toSpec } from "./spec.js";
import { type CountedAs, effectiveCountedAs, type ProfileSpec, speedDisplay, validateProfile } from "./rules.js";
import { areCompatible } from "../../lib/units/quantity.js";

// Station profiles (ADR-0017): a per-site list of named kinds of machine.

type ServiceError = { error: string; code: string };

const DUPLICATE_NAME: ServiceError = {
  error: "A profile with this name already exists for this site",
  code: "DUPLICATE_NAME",
};
const NOT_FOUND: ServiceError = { error: "Profile not found", code: "PROFILE_NOT_FOUND" };

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export interface CreateStationProfileInput {
  siteId: string;
  name: string;
  description?: string | null;
  cycleMode: CycleModeValue;
  quantityUnit?: string;
  signalAmount?: number | null;
  signalInterval?: number | null;
  countedAs?: CountedAs;
  standardCycle?: number | null;
  standardRate?: number | null;
  standardRateUnit?: string;
  standardRatePeriod?: RatePeriod;
}

export type UpdateStationProfileInput = Partial<Omit<CreateStationProfileInput, "siteId">>;

export interface ListStationProfilesFilter {
  siteId?: string;
  includeArchived?: boolean;
  name?: string;
  limit?: number;
  offset?: number;
}

/** How many live stations and jobs use each profile. */
async function usage(profileIds: string[]) {
  if (profileIds.length === 0) return new Map<string, { stations: number; jobs: number }>();
  const [stations, jobs] = await Promise.all([
    prisma.stationVersion.groupBy({
      by: ["profileId"],
      where: { profileId: { in: profileIds }, currentOfStation: { is: { deletedAt: null } } },
      _count: { _all: true },
    }),
    prisma.jobVersion.groupBy({
      by: ["profileId"],
      where: { profileId: { in: profileIds }, currentOfJob: { is: { deletedAt: null } } },
      _count: { _all: true },
    }),
  ]);
  const out = new Map(profileIds.map((id) => [id, { stations: 0, jobs: 0 }]));
  for (const s of stations) {
    const row = s.profileId ? out.get(s.profileId) : undefined;
    if (row) row.stations = s._count._all;
  }
  for (const j of jobs) {
    const row = j.profileId ? out.get(j.profileId) : undefined;
    if (row) row.jobs = j._count._all;
  }
  return out;
}

function present(row: ProfileRow, used?: { stations: number; jobs: number }) {
  const spec = toSpec(row);
  return {
    ...row,
    ...spec,
    speedDisplay: speedDisplay(spec),
    usage: used ?? { stations: 0, jobs: 0 },
  };
}

export async function create(input: CreateStationProfileInput) {
  const site = await prisma.site.findUnique({ where: { id: input.siteId }, select: { id: true } });
  if (!site) return { error: "Site not found", code: "SITE_NOT_FOUND" };

  const checked = validateProfile({
    cycleMode: input.cycleMode,
    quantityUnit: input.quantityUnit ?? "",
    signalAmount: input.signalAmount ?? null,
    signalInterval: input.signalInterval ?? null,
    countedAs: effectiveCountedAs(input.cycleMode, input.countedAs),
    standardCycle: input.standardCycle ?? null,
    standardRate: input.standardRate ?? null,
    standardRateUnit: input.standardRateUnit ?? "",
    standardRatePeriod: input.standardRatePeriod ?? "MINUTE",
  });
  if ("error" in checked) return checked;

  try {
    const row = await prisma.stationProfile.create({
      data: { siteId: input.siteId, name: input.name, description: input.description ?? null, ...checked.data },
    });
    return { data: present(row) };
  } catch (err) {
    if (isUniqueViolation(err)) return DUPLICATE_NAME;
    throw err;
  }
}

export async function list(filter: ListStationProfilesFilter = {}) {
  const { siteId, includeArchived, name, limit = 50, offset = 0 } = filter;
  const where: Prisma.StationProfileWhereInput = {};
  if (!includeArchived) where.archivedAt = null;
  if (siteId) where.siteId = siteId;
  if (name) where.name = { contains: name, mode: "insensitive" };

  const [rows, total] = await Promise.all([
    prisma.stationProfile.findMany({
      where,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.stationProfile.count({ where }),
  ]);
  const used = await usage(rows.map((r) => r.id));
  return { data: rows.map((r) => present(r, used.get(r.id))), total, limit: Number(limit), offset: Number(offset) };
}

export async function getById(id: string) {
  const row = await prisma.stationProfile.findUnique({ where: { id } });
  if (!row || row.archivedAt) return null;
  const used = await usage([id]);
  return { data: present(row, used.get(id)) };
}

/**
 * Edit a profile. Stations that follow it get a new version with the new
 * values at once. While any station or job uses it, a profile cannot switch
 * how it counts or move to a unit of another kind — that would change what
 * every recorded number means; make a new profile instead.
 */
export async function update(id: string, input: UpdateStationProfileInput) {
  const row = await prisma.stationProfile.findUnique({ where: { id } });
  if (!row || row.archivedAt) return NOT_FOUND;
  const before = toSpec(row);

  const cycleMode = input.cycleMode ?? before.cycleMode;
  const merged: ProfileSpec = {
    cycleMode,
    quantityUnit: input.quantityUnit ?? before.quantityUnit,
    signalAmount: input.signalAmount !== undefined ? input.signalAmount : before.signalAmount,
    signalInterval: input.signalInterval !== undefined ? input.signalInterval : before.signalInterval,
    countedAs: effectiveCountedAs(cycleMode, input.countedAs ?? before.countedAs),
    standardCycle: input.standardCycle !== undefined ? input.standardCycle : before.standardCycle,
    standardRate: input.standardRate !== undefined ? input.standardRate : before.standardRate,
    standardRateUnit: input.standardRateUnit ?? before.standardRateUnit,
    standardRatePeriod: input.standardRatePeriod ?? before.standardRatePeriod,
  };
  const checked = validateProfile(merged);
  if ("error" in checked) return checked;
  const next = checked.data;

  const kindChanged =
    next.cycleMode !== before.cycleMode ||
    next.countedAs !== before.countedAs ||
    !areCompatible(next.quantityUnit, before.quantityUnit);
  if (kindChanged) {
    const used = (await usage([id])).get(id);
    if (used && (used.stations > 0 || used.jobs > 0)) {
      return {
        error: `This profile is used by ${used.stations} station(s) and ${used.jobs} job(s), so it can't change how it counts. Make a new profile instead.`,
        code: "PROFILE_IN_USE",
      };
    }
  }

  let updated: ProfileRow;
  try {
    updated = await prisma.stationProfile.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...next,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return DUPLICATE_NAME;
    throw err;
  }

  await applyProfileToStations(id);

  const used = await usage([id]);
  return { data: present(updated, used.get(id)) };
}

/** Archive a profile no live station uses. Jobs keep pointing at it. */
export async function archive(id: string) {
  const row = await prisma.stationProfile.findUnique({ where: { id }, select: { archivedAt: true } });
  if (!row || row.archivedAt) return NOT_FOUND;
  const used = (await usage([id])).get(id);
  if (used && used.stations > 0) {
    return {
      error: `${used.stations} station(s) still use this profile. Move them to another profile first.`,
      code: "PROFILE_IN_USE",
    };
  }
  await prisma.stationProfile.update({ where: { id }, data: { archivedAt: new Date() } });
  return { data: { success: true } };
}

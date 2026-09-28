import prisma, { Prisma } from "@rw/db";
import type { CycleModeValue } from "../../cycle/standards.js";
import type { RatePeriod } from "../../lib/units/quantity.js";
import { applyProfileToStations } from "./apply.js";
import { ensureDefaultProfile } from "./default.js";
import { LIVE_VARIATIONS, type ProfileWithVariations, toSpec, toVariationSpec } from "./spec.js";
import {
  type CountedAs,
  effectiveCountedAs,
  type ProfileSpec,
  speedDisplay,
  type VariationSpec,
  validateProfile,
  validateVariations,
} from "./rules.js";
import { areCompatible } from "../../lib/units/quantity.js";

// Station profiles (ADR-0017): a per-site list of named kinds of machine.
// Every site has one default, "Discrete" (see default.ts). Each profile has
// one or more variations (§8): how a group of its machines signals.

type ServiceError = { error: string; code: string };

const DUPLICATE_NAME: ServiceError = {
  error: "A profile with this name already exists for this site",
  code: "DUPLICATE_NAME",
};
const NOT_FOUND: ServiceError = { error: "Profile not found", code: "PROFILE_NOT_FOUND" };

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** A variation as create/update take it; `id` names an existing one on update. */
export interface StationProfileVariationInput {
  id?: string;
  name?: string;
  description?: string | null;
  signalAmount?: number | null;
  signalInterval?: number | null;
}

export interface CreateStationProfileInput {
  siteId: string;
  name: string;
  cycleMode: CycleModeValue;
  quantityUnit?: string;
  countedAs?: CountedAs;
  standardCycle?: number | null;
  standardRate?: number | null;
  standardRateUnit?: string;
  standardRatePeriod?: RatePeriod;
  /** The profile's variations, in page order. At least one. */
  variations?: StationProfileVariationInput[];
  /**
   * Older clients, with no variations: these set the profile's one
   * variation (on update, its first).
   */
  description?: string | null;
  signalAmount?: number | null;
  signalInterval?: number | null;
}

export type UpdateStationProfileInput = Partial<Omit<CreateStationProfileInput, "siteId">>;

export interface ListStationProfilesFilter {
  siteId?: string;
  includeArchived?: boolean;
  name?: string;
  limit?: number;
  offset?: number;
}

const WITH_VARIATIONS = { variations: LIVE_VARIATIONS } as const;

/** How many live stations and jobs use each profile, and stations per variation. */
async function usage(profileIds: string[]) {
  const variations = new Map<string, number>();
  if (profileIds.length === 0) return { profiles: new Map<string, { stations: number; jobs: number }>(), variations };
  const live = { currentOfStation: { is: { deletedAt: null } } };
  const [stations, jobs, byVariation] = await Promise.all([
    prisma.stationVersion.groupBy({
      by: ["profileId"],
      where: { profileId: { in: profileIds }, ...live },
      _count: { _all: true },
    }),
    prisma.jobVersion.groupBy({
      by: ["profileId"],
      where: { profileId: { in: profileIds }, currentOfJob: { is: { deletedAt: null } } },
      _count: { _all: true },
    }),
    prisma.stationVersion.groupBy({
      by: ["variationId"],
      where: { profileId: { in: profileIds }, variationId: { not: null }, ...live },
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
  for (const v of byVariation) if (v.variationId) variations.set(v.variationId, v._count._all);
  return { profiles: out, variations };
}

type Usage = Awaited<ReturnType<typeof usage>>;

/**
 * A profile as the endpoints return it: the profile, its variations with how
 * many stations follow each, and — for clients from before variations — the
 * first variation's description and signal fields at the top level.
 */
function present(row: ProfileWithVariations, used?: Usage) {
  const { variations, ...profile } = row;
  const first = variations[0] ?? null;
  const spec = toSpec(profile, first);
  return {
    ...profile,
    ...spec,
    description: first?.description ?? null,
    variations: variations.map((variation) => ({
      ...toVariationSpec(variation),
      position: variation.position,
      usage: { stations: used?.variations.get(variation.id) ?? 0 },
    })),
    speedDisplay: speedDisplay(spec),
    usage: used?.profiles.get(profile.id) ?? { stations: 0, jobs: 0 },
  };
}

function variationSpecs(input: StationProfileVariationInput[]): VariationSpec[] {
  return input.map((variation) => ({
    ...(variation.id ? { id: variation.id } : {}),
    name: variation.name ?? "",
    description: variation.description ?? null,
    signalAmount: variation.signalAmount ?? null,
    signalInterval: variation.signalInterval ?? null,
  }));
}

/** Check the profile-level fields, then each variation against them. */
function validate(
  spec: ProfileSpec,
  variations: VariationSpec[],
): ServiceError | { profile: ProfileSpec; variations: VariationSpec[] } {
  const checkedVariations = validateVariations(spec.cycleMode, variations);
  if ("error" in checkedVariations) return checkedVariations;
  const [first] = checkedVariations.data;
  const checked = validateProfile({
    ...spec,
    signalAmount: first?.signalAmount ?? null,
    signalInterval: first?.signalInterval ?? null,
  });
  if ("error" in checked) return checked;
  return { profile: checked.data, variations: checkedVariations.data };
}

/** The profile-level columns (signal fields live on variations). */
function profileColumns(spec: ProfileSpec) {
  const { signalAmount: _a, signalInterval: _i, ...columns } = spec;
  return columns;
}

function variationColumns(variation: VariationSpec, position: number) {
  return {
    name: variation.name,
    description: variation.description,
    signalAmount: variation.signalAmount,
    signalInterval: variation.signalInterval,
    position,
  };
}

type Presented = ReturnType<typeof present>;

export async function create(input: CreateStationProfileInput): Promise<ServiceError | { data: Presented }> {
  const site = await prisma.site.findUnique({ where: { id: input.siteId }, select: { id: true } });
  if (!site) return { error: "Site not found", code: "SITE_NOT_FOUND" };

  const checked = validate(
    {
      cycleMode: input.cycleMode,
      quantityUnit: input.quantityUnit ?? "",
      signalAmount: null,
      signalInterval: null,
      countedAs: effectiveCountedAs(input.cycleMode, input.countedAs),
      standardCycle: input.standardCycle ?? null,
      standardRate: input.standardRate ?? null,
      standardRateUnit: input.standardRateUnit ?? "",
      standardRatePeriod: input.standardRatePeriod ?? "MINUTE",
    },
    variationSpecs(
      input.variations ?? [
        { description: input.description, signalAmount: input.signalAmount, signalInterval: input.signalInterval },
      ],
    ).map(({ id: _id, ...variation }) => variation),
  );
  if ("error" in checked) return checked;

  try {
    const row = await prisma.stationProfile.create({
      data: {
        siteId: input.siteId,
        name: input.name,
        ...profileColumns(checked.profile),
        variations: { create: checked.variations.map((variation, index) => variationColumns(variation, index)) },
      },
      include: WITH_VARIATIONS,
    });
    return { data: present(row) };
  } catch (err) {
    if (isUniqueViolation(err)) return DUPLICATE_NAME;
    throw err;
  }
}

export async function list(filter: ListStationProfilesFilter = {}) {
  const { siteId, includeArchived, name, limit = 50, offset = 0 } = filter;
  // A site always has its default, even before anything asked for it.
  if (siteId) await ensureDefaultProfile(siteId);
  const where: Prisma.StationProfileWhereInput = {};
  if (!includeArchived) where.archivedAt = null;
  if (siteId) where.siteId = siteId;
  if (name) where.name = { contains: name, mode: "insensitive" };

  const [rows, total] = await Promise.all([
    prisma.stationProfile.findMany({
      where,
      include: WITH_VARIATIONS,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      // The default first, then by name.
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    }),
    prisma.stationProfile.count({ where }),
  ]);
  const used = await usage(rows.map((r) => r.id));
  return { data: rows.map((r) => present(r, used)), total, limit: Number(limit), offset: Number(offset) };
}

/** The site's default profile (made if missing). */
export async function getDefault(siteId: string) {
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true } });
  if (!site) return { error: "Site not found", code: "SITE_NOT_FOUND" };
  const { id } = await ensureDefaultProfile(siteId);
  const row = await prisma.stationProfile.findUniqueOrThrow({ where: { id }, include: WITH_VARIATIONS });
  return { data: present(row, await usage([id])) };
}

export async function getById(id: string) {
  const row = await prisma.stationProfile.findUnique({ where: { id }, include: WITH_VARIATIONS });
  if (!row || row.archivedAt) return null;
  return { data: present(row, await usage([id])) };
}

/**
 * Jobs on this profile that break the finished-parts rule: a count that is
 * finished parts goes to one product at ×1, so each job needs exactly one
 * active product with quantity 1.
 */
async function jobsBreakingOneOutput(profileId: string): Promise<number> {
  const jobs = await prisma.job.findMany({
    where: { deletedAt: null, currentVersion: { profileId } },
    select: {
      jobProducts: {
        where: { deletedAt: null },
        select: { currentVersion: { select: { isActive: true, quantity: true } } },
      },
    },
  });
  return jobs.filter((job) => {
    const active = job.jobProducts.filter((product) => product.currentVersion?.isActive);
    return active.length !== 1 || active[0]?.currentVersion?.quantity !== 1;
  }).length;
}

/**
 * Edit a profile (never the Discrete default) and its variations. Stations
 * that follow it get a new version with the new values at once. While any
 * station or job uses it, a profile cannot switch how it counts or move to a
 * unit of another kind — that would change what every recorded number means;
 * make a new profile instead. It may switch between parts and strokes
 * (ADR §7): to strokes always, to finished parts once every job on it makes
 * one product at ×1.
 *
 * `variations`, when sent, is the whole list: an entry with an `id` edits
 * that variation, one without adds a variation, and a live variation left
 * out is archived — refused while stations follow it.
 */
export async function update(
  id: string,
  input: UpdateStationProfileInput,
): Promise<ServiceError | { data: Presented }> {
  const row = await prisma.stationProfile.findUnique({ where: { id }, include: WITH_VARIATIONS });
  if (!row || row.archivedAt) return NOT_FOUND;
  const before = toSpec(row);

  // The Discrete default is fixed: always count by cycle, no standard of its
  // own (every job sets its own standard cycle time), and no renaming.
  if (row.isDefault) {
    return { error: "The default profile can't be changed.", code: "PROFILE_IS_DEFAULT" };
  }

  const current = row.variations.map(toVariationSpec);
  let nextVariations: VariationSpec[];
  if (input.variations) {
    const known = new Set(current.map((variation) => variation.id));
    const unknown = input.variations.find((variation) => variation.id && !known.has(variation.id));
    if (unknown) return { error: "That variation isn't on this profile", code: "VARIATION_NOT_FOUND" };
    nextVariations = variationSpecs(input.variations);
  } else {
    // An older client edits the one variation it knows: the first.
    const [first, ...rest] = current;
    nextVariations = first
      ? [
          {
            ...first,
            description: input.description !== undefined ? input.description : first.description,
            signalAmount: input.signalAmount !== undefined ? input.signalAmount : first.signalAmount,
            signalInterval: input.signalInterval !== undefined ? input.signalInterval : first.signalInterval,
          },
          ...rest,
        ]
      : [
          {
            name: "",
            description: input.description ?? null,
            signalAmount: input.signalAmount ?? null,
            signalInterval: input.signalInterval ?? null,
          },
        ];
  }

  const cycleMode = input.cycleMode ?? before.cycleMode;
  const checked = validate(
    {
      ...before,
      cycleMode,
      quantityUnit: input.quantityUnit ?? before.quantityUnit,
      countedAs: effectiveCountedAs(cycleMode, input.countedAs ?? before.countedAs),
      standardCycle: input.standardCycle !== undefined ? input.standardCycle : before.standardCycle,
      standardRate: input.standardRate !== undefined ? input.standardRate : before.standardRate,
      standardRateUnit: input.standardRateUnit ?? before.standardRateUnit,
      standardRatePeriod: input.standardRatePeriod ?? before.standardRatePeriod,
    },
    nextVariations,
  );
  if ("error" in checked) return checked;
  const next = checked.profile;

  const used = await usage([id]);
  const profileUsed = used.profiles.get(id);
  const inUse = !!profileUsed && (profileUsed.stations > 0 || profileUsed.jobs > 0);
  const kindChanged = next.cycleMode !== before.cycleMode || !areCompatible(next.quantityUnit, before.quantityUnit);
  if (kindChanged && inUse) {
    return {
      error: `This profile is used by ${profileUsed.stations} station(s) and ${profileUsed.jobs} job(s), so it can't change how it counts. Make a new profile instead.`,
      code: "PROFILE_IN_USE",
    };
  }
  if (inUse && next.countedAs === "OUTPUT" && before.countedAs !== "OUTPUT") {
    const breaking = await jobsBreakingOneOutput(id);
    if (breaking > 0) {
      return {
        error: `${breaking} job(s) on this profile make more than one product, or more than one of it. A count of finished parts goes to one product at ×1, so change those jobs first.`,
        code: "PROFILE_OUTPUT_RULE",
      };
    }
  }

  const keptIds = new Set(checked.variations.flatMap((variation) => (variation.id ? [variation.id] : [])));
  const dropped = current.filter((variation) => !keptIds.has(variation.id));
  const followed = dropped.find((variation) => (used.variations.get(variation.id) ?? 0) > 0);
  if (followed) {
    const count = used.variations.get(followed.id) ?? 0;
    return {
      error: `${count} station(s) follow "${followed.name || "this variation"}". Move them to another variation first.`,
      code: "VARIATION_IN_USE",
    };
  }

  let updated: ProfileWithVariations;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await tx.stationProfile.update({
        where: { id },
        data: { ...(input.name !== undefined ? { name: input.name } : {}), ...profileColumns(next) },
      });
      if (dropped.length > 0) {
        await tx.stationProfileVariation.updateMany({
          where: { id: { in: dropped.map((variation) => variation.id) } },
          data: { archivedAt: new Date() },
        });
      }
      for (const [index, variation] of checked.variations.entries()) {
        const columns = variationColumns(variation, index);
        if (variation.id) await tx.stationProfileVariation.update({ where: { id: variation.id }, data: columns });
        else await tx.stationProfileVariation.create({ data: { ...columns, profileId: id } });
      }
      return tx.stationProfile.findUniqueOrThrow({ where: { id }, include: WITH_VARIATIONS });
    });
  } catch (err) {
    if (isUniqueViolation(err)) return DUPLICATE_NAME;
    throw err;
  }

  await applyProfileToStations(id);

  return { data: present(updated, await usage([id])) };
}

/** Archive a profile no live station uses. Jobs keep pointing at it. */
export async function archive(id: string) {
  const row = await prisma.stationProfile.findUnique({ where: { id }, select: { archivedAt: true, isDefault: true } });
  if (!row || row.archivedAt) return NOT_FOUND;
  if (row.isDefault) {
    return { error: "The default profile can't be archived.", code: "PROFILE_IS_DEFAULT" };
  }
  const used = (await usage([id])).profiles.get(id);
  if (used && used.stations > 0) {
    return {
      error: `${used.stations} station(s) still use this profile. Move them to another profile first.`,
      code: "PROFILE_IN_USE",
    };
  }
  await prisma.stationProfile.update({ where: { id }, data: { archivedAt: new Date() } });
  return { data: { success: true } };
}

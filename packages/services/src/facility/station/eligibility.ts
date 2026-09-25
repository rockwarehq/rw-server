import prisma, { type Prisma } from "@rw/db";
import type { CycleModeValue } from "../../cycle/standards.js";
import { decimalToNumber } from "../../metrics/sync.js";
import { COUNT_NAMES, type CountedAs, kindOf, kindsMatch } from "../station-profile/rules.js";

// Where a job can run (ADR-0017): one check, used by changeJob, history
// amendments, and the "which stations / which jobs" lists. Two gates:
//   1. Kind — the job's profile must count the same way as the station, in a
//      unit of the same kind. The math depends on it, so it always holds.
//      A job with no profile counts as the Discrete default (unless it has a
//      rate, then this gate is skipped).
//   2. Labels — the station's JOB label filter (ADR-0011): the job must
//      carry at least one of its labels. No filter, or an empty one, passes.

type Client = Prisma.TransactionClient | typeof prisma;

export type EligibilityCode = "PROFILE_MISMATCH" | "LABEL_FILTER_MISMATCH";

export interface EligibilityReason {
  code: EligibilityCode;
  message: string;
  /** LABEL_FILTER_MISMATCH: the labels the station's filter wants. */
  labels?: { id: string; name: string }[];
}

export interface EligibilityStation {
  name: string;
  cycleMode: CycleModeValue;
  quantityUnit: string;
  /** The station's profile's countedAs; null when the station has no profile. */
  countedAs: CountedAs | null;
  /** Labels in the station's JOB filter; empty = no filter. */
  jobFilterLabels: { id: string; name: string }[];
}

export interface EligibilityJob {
  name: string;
  labelIds: string[];
  /** Null = an older job with no profile yet. */
  profile: { cycleMode: CycleModeValue; countedAs: CountedAs; quantityUnit: string } | null;
  /** The job has its own rate (only matters when it has no profile). */
  hasRate?: boolean;
}

const DISCRETE_DEFAULT = { cycleMode: "DISCRETE" as const, countedAs: "CYCLES" as const, quantityUnit: "" };

export function checkEligibility(station: EligibilityStation, job: EligibilityJob): EligibilityReason[] {
  const reasons: EligibilityReason[] = [];

  // A job with no profile counts as the Discrete default — unless it carries
  // a rate, which says it is for another kind of machine we can't name yet.
  const jobProfile = job.profile ?? (job.hasRate ? null : DISCRETE_DEFAULT);
  if (jobProfile) {
    const jobKind = kindOf(jobProfile.cycleMode, jobProfile.countedAs, jobProfile.quantityUnit);
    const stationKind =
      station.countedAs == null
        ? { cycleMode: station.cycleMode, countedAs: null, quantityUnit: station.quantityUnit }
        : kindOf(station.cycleMode, station.countedAs, station.quantityUnit);
    if (!kindsMatch(jobKind, stationKind)) {
      reasons.push({
        code: "PROFILE_MISMATCH",
        message: `Job ${job.name} is set up for ${describe(jobKind)}, but ${station.name} ${describeStation(stationKind)}.`,
      });
    }
  }

  if (station.jobFilterLabels.length > 0) {
    const allowed = new Set(station.jobFilterLabels.map((l) => l.id));
    if (!job.labelIds.some((id) => allowed.has(id))) {
      // The message is the one changeJob has always returned (API text).
      reasons.push({
        code: "LABEL_FILTER_MISMATCH",
        message: "The station's job filter does not allow this job",
        labels: station.jobFilterLabels,
      });
    }
  }

  return reasons;
}

function describe(kind: { cycleMode: CycleModeValue; countedAs: CountedAs | null; quantityUnit: string }): string {
  const name = COUNT_NAMES[kind.cycleMode];
  if (kind.cycleMode === "DISCRETE") return name;
  const what =
    kind.cycleMode === "QUANTITY_PER_INTERVAL" && kind.countedAs === "CYCLES" ? "strokes" : kind.quantityUnit;
  return `${name} (${what})`;
}

function describeStation(kind: {
  cycleMode: CycleModeValue;
  countedAs: CountedAs | null;
  quantityUnit: string;
}): string {
  return `counts as ${describe(kind)}`;
}

// ── Loading ─────────────────────────────────────────────────────────────

const stationSelect = {
  id: true,
  name: true,
  siteId: true,
  currentVersion: {
    select: {
      cycleMode: true,
      quantityUnit: true,
      standardCycle: true,
      standardRate: true,
      standardRateUnit: true,
      standardRatePeriod: true,
      speedFromProfile: true,
      profile: { select: { id: true, name: true, countedAs: true } },
    },
  },
  labelFilters: { where: { target: "JOB" as const }, select: { labels: { select: { id: true, name: true } } } },
} satisfies Prisma.StationSelect;

const jobSelect = {
  id: true,
  siteId: true,
  labels: { select: { id: true } },
  currentVersion: {
    select: {
      name: true,
      standardRate: true,
      profile: { select: { id: true, cycleMode: true, countedAs: true, quantityUnit: true } },
    },
  },
} satisfies Prisma.JobSelect;

type StationRow = Prisma.StationGetPayload<{ select: typeof stationSelect }>;
type JobRow = Prisma.JobGetPayload<{ select: typeof jobSelect }>;

function toStation(row: StationRow): EligibilityStation {
  return {
    name: row.name,
    cycleMode: (row.currentVersion?.cycleMode ?? "DISCRETE") as CycleModeValue,
    quantityUnit: row.currentVersion?.quantityUnit ?? "",
    countedAs: (row.currentVersion?.profile?.countedAs ?? null) as CountedAs | null,
    jobFilterLabels: row.labelFilters[0]?.labels ?? [],
  };
}

function toJob(row: JobRow): EligibilityJob {
  const p = row.currentVersion?.profile;
  return {
    name: row.currentVersion?.name ?? "",
    labelIds: row.labels.map((l) => l.id),
    hasRate: row.currentVersion?.standardRate != null,
    profile: p
      ? { cycleMode: p.cycleMode as CycleModeValue, countedAs: p.countedAs as CountedAs, quantityUnit: p.quantityUnit }
      : null,
  };
}

/** Why this job can't run on this station; empty = it can. Used inside the changeJob transaction. */
export async function canRunJob(client: Client, stationId: string, jobId: string): Promise<EligibilityReason[]> {
  const [station, job] = await Promise.all([
    client.station.findUnique({ where: { id: stationId }, select: stationSelect }),
    client.job.findUnique({ where: { id: jobId }, select: jobSelect }),
  ]);
  if (!station || !job) return [];
  return checkEligibility(toStation(station), toJob(job));
}

/** Every live station on the job's site, with the reasons it can't run the job (empty = it can). */
export async function eligibleStations(jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { ...jobSelect, deletedAt: true } });
  if (!job || job.deletedAt) return { error: "Job not found", code: "JOB_NOT_FOUND" };
  const stations = await prisma.station.findMany({
    where: { siteId: job.siteId, deletedAt: null, archivedAt: null },
    select: stationSelect,
    orderBy: { name: "asc" },
  });
  const j = toJob(job);
  return {
    data: stations.map((s) => ({
      stationId: s.id,
      stationName: s.name,
      profile: s.currentVersion?.profile
        ? { id: s.currentVersion.profile.id, name: s.currentVersion.profile.name }
        : null,
      // The station's own speed, when it has one (shown next to the job's).
      ownSpeed:
        s.currentVersion?.profile && !s.currentVersion.speedFromProfile
          ? {
              standardCycle: decimalToNumber(s.currentVersion.standardCycle),
              standardRate: decimalToNumber(s.currentVersion.standardRate),
              standardRateUnit: s.currentVersion.standardRateUnit,
              standardRatePeriod: s.currentVersion.standardRatePeriod,
            }
          : null,
      reasons: checkEligibility(toStation(s), j),
    })),
  };
}

/** Jobs on the station's site that it can run. `includeBlocked` also returns the rest, with reasons. */
export async function eligibleJobs(
  stationId: string,
  opts: { q?: string; includeBlocked?: boolean; limit?: number; offset?: number } = {},
) {
  const station = await prisma.station.findUnique({ where: { id: stationId }, select: stationSelect });
  if (!station) return { error: "Station not found", code: "STATION_NOT_FOUND" };
  const where: Prisma.JobWhereInput = { siteId: station.siteId, deletedAt: null, archivedAt: null };
  if (opts.q) where.currentVersion = { name: { contains: opts.q, mode: "insensitive" } };
  const jobs = await prisma.job.findMany({ where, select: jobSelect, orderBy: { createdAt: "desc" } });

  const s = toStation(station);
  const rows = jobs
    .map((job) => ({
      jobId: job.id,
      jobName: job.currentVersion?.name ?? "",
      profile: job.currentVersion?.profile ? { id: job.currentVersion.profile.id } : null,
      reasons: checkEligibility(s, toJob(job)),
    }))
    .filter((r) => opts.includeBlocked || r.reasons.length === 0)
    .sort((a, b) => a.jobName.localeCompare(b.jobName));
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 50;
  return {
    data: limit > 0 ? rows.slice(offset, offset + limit) : rows.slice(offset),
    total: rows.length,
    limit,
    offset,
  };
}

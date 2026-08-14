import { createHash } from "node:crypto";
import prisma from "@rw/db";
import { ADDITIVE_KPI_KEYS, computeAllKpis, sumKPIs, ZERO_KPIS, type BucketKPIs } from "@rockwarehq/metrics";
import { MetricsContext } from "@rw/services/metrics/context";
import { resolveEntityName, resolveEntityPath } from "@rw/services/metrics/hierarchy";
import {
  aggregateJobHours,
  aggregateStationHours,
  aggregateStationTotal,
  type BucketAggregate,
} from "@rw/services/metrics/read";
import { getShiftInstancesForRange, type ShiftWindow } from "@rw/services/metrics/shift";
import { decimalToNumber, rowToSnapshot, type BucketSnapshot } from "@rw/services/metrics/sync";

export type BucketEntityType = "STATION" | "WORKCENTER" | "SITE" | "JOB";
export type BucketGranularity = "MINUTE" | "HOUR" | "SHIFT" | "DAY";

type SnapshotSourceRow = Parameters<typeof rowToSnapshot>[0];

interface MetricBucketQueryRow extends SnapshotSourceRow {
  id: string;
  siteId: string;
  entityType: BucketEntityType;
  entityId: string;
  jobId: string | null;
  entityName: string;
  path: string;
  granularity: BucketGranularity;
  granularityName: string;
  startTime: Date;
  durationSeconds: number;
  shiftInstanceId: string | null;
  businessDate: Date | null;
  businessShift: string | null;
  updatedAt: Date;
}

export interface EntitySubscription {
  entityType: BucketEntityType;
  /** For JOB entities this is the station id (see jobId). */
  entityId: string;
  /** Job id — required when entityType is "JOB", omitted otherwise. */
  jobId?: string | null;
  granularities: BucketGranularity[];
}

export interface GetBucketsInput {
  siteId: string;
  entities: EntitySubscription[];
  startTime?: Date;
  endTime?: Date;
  businessDate?: Date;
  limit?: number;
  offset?: number;
}

export interface BucketRow {
  id: string;
  siteId: string;
  entityType: BucketEntityType;
  entityId: string;
  jobId: string | null;
  entityName: string;
  path: string;
  granularity: BucketGranularity;
  granularityName: string;
  startTime: Date;
  durationSeconds: number;
  shiftInstanceId: string | null;
  businessDate: Date | null;
  businessShift: string | null;
  snapshot: BucketSnapshot;
}

async function resolveMetadata(
  siteId: string,
  entityType: BucketEntityType,
  entityId: string,
  knownName: string | undefined,
  knownPath: string | undefined,
  ctx: MetricsContext,
  jobId?: string | null,
): Promise<{ entityName: string; path: string }> {
  // For JOB entities, entityId is the station id — the name resolves via
  // the job id and the path is station path + `.job.{jobId}`.
  const [entityName, path] = await Promise.all([
    resolveEntityName(entityType, entityType === "JOB" && jobId ? jobId : entityId, knownName, ctx),
    resolveEntityPath(entityType, entityId, siteId, knownPath, ctx, jobId),
  ]);

  return { entityName, path };
}

// ── Star-schema Stage B: read-time derivation helpers ────────────
//
// MetricBucket is collapsing to one persisted grain — STATION-family HOUR
// rows keyed (entityType, entityId=stationId, jobId nullable, HOUR,
// startTime). Coarser slices (SHIFT/DAY rows, WORKCENTER/SITE rollups) are
// derived at read time by summing hour rows via the read service and
// recomputing the four ratios from the summed ingredients — ratios are
// NEVER summed or averaged.

/**
 * Deterministic uuid for derived (non-persisted) bucket rows:
 * md5(`${entityType}|${entityId}|${jobId ?? ""}|${granularity}|${startTime.toISOString()}`)
 * with RFC 4122 version/variant bits stamped so `z.uuid()` accepts it.
 */
export function syntheticBucketId(
  entityType: BucketEntityType,
  entityId: string,
  jobId: string | null | undefined,
  granularity: BucketGranularity,
  startTime: Date,
): string {
  const digest = createHash("md5")
    .update(`${entityType}|${entityId}|${jobId ?? ""}|${granularity}|${startTime.toISOString()}`)
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x30; // version 3 (md5-derived)
  digest[8] = (digest[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Member stations whose hour rows make up a WORKCENTER/SITE aggregate. */
export async function resolveMemberStationIds(
  entityType: "WORKCENTER" | "SITE",
  entityId: string,
  siteId: string,
): Promise<string[]> {
  if (entityType === "SITE") {
    const stations = await prisma.station.findMany({
      where: { siteId: entityId, deletedAt: null },
      select: { id: true },
    });
    return stations.map((station) => station.id);
  }

  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE wc AS (
      SELECT id FROM "Workcenter" WHERE id = ${entityId}::uuid
      UNION ALL
      SELECT w.id FROM "Workcenter" w JOIN wc ON w."parentId" = wc.id
    )
    SELECT s.id FROM "Station" s
    WHERE s."workcenterId" IN (SELECT id FROM wc)
      AND s."siteId" = ${siteId}::uuid
      AND s."deletedAt" IS NULL
  `;
  return rows.map((row) => row.id);
}

/**
 * Map a read-service aggregate onto the BucketSnapshot wire shape. The four
 * ratios come from the aggregate's `computed` block (recomputed from summed
 * ingredients); `plannedProductionSeconds` mirrors the DB generated column
 * (durationSeconds - plannedDownSeconds) summed across contributing rows.
 */
export function aggregateToSnapshot(
  agg: BucketAggregate,
  meta: {
    shiftInstanceId: string | null;
    businessDate: Date | null;
    businessShift: string | null;
    /** Job display fields are null for WORKCENTER/SITE (matches persisted rows). */
    includeJobDisplay: boolean;
  },
): BucketSnapshot {
  const k = agg.kpis;
  return {
    totalCycles: k.totalCycles,
    goodCycles: k.totalCycles - k.badCycles,
    badCycles: k.badCycles,
    totalItems: k.totalItems,
    goodItems: k.totalItems - k.badItems,
    badItems: k.badItems,
    expectedCycles: k.expectedCycles,
    expectedItems: k.expectedItems,
    runSeconds: k.runSeconds,
    downSeconds: k.downSeconds,
    plannedDownSeconds: k.plannedDownSeconds,
    unplannedDownSeconds: k.unplannedDownSeconds,
    plannedProductionSeconds: agg.durationSeconds - k.plannedDownSeconds,
    idealCycleSeconds: k.idealCycleSeconds,
    totalCycleSeconds: k.totalCycleSeconds,
    elapsedExpectedCycles: k.elapsedExpectedCycles,
    elapsedExpectedItems: k.elapsedExpectedItems,
    elapsedPlannedProductionSeconds: k.elapsedPlannedProductionSeconds,
    currentStandardCycle: agg.currentStandardCycle,
    availability: agg.computed.availability,
    performance: agg.computed.performance,
    quality: agg.computed.quality,
    oee: agg.computed.oee,
    shiftInstanceId: meta.shiftInstanceId,
    businessDate: meta.businessDate ? meta.businessDate.toISOString().slice(0, 10) : null,
    businessShift: meta.businessShift,
    currentJobId: meta.includeJobDisplay ? agg.currentJobId : null,
    currentJobName: meta.includeJobDisplay ? agg.currentJobName : null,
  };
}

/**
 * Combine per-shift aggregates into a coarser one (DAY). Additive KPIs are
 * summed and ratios recomputed from the sums; display fields come from the
 * latest contributing aggregate (callers pass in startTime order).
 */
export function combineAggregates(aggs: BucketAggregate[]): BucketAggregate {
  const nonEmpty = aggs.filter((agg) => agg.bucketCount > 0);
  const kpis = sumKPIs(nonEmpty.map((agg) => agg.kpis));
  const latest = nonEmpty.length > 0 ? nonEmpty[nonEmpty.length - 1] : null;
  kpis.currentStandardCycle = latest?.currentStandardCycle ?? null;

  let firstStartTime: Date | null = null;
  let durationSeconds = 0;
  let bucketCount = 0;
  for (const agg of nonEmpty) {
    if (agg.firstStartTime && (!firstStartTime || agg.firstStartTime < firstStartTime)) {
      firstStartTime = agg.firstStartTime;
    }
    durationSeconds += agg.durationSeconds;
    bucketCount += agg.bucketCount;
  }

  return {
    kpis,
    computed: computeAllKpis(kpis),
    currentStandardCycle: latest?.currentStandardCycle ?? null,
    currentJobId: latest?.currentJobId ?? null,
    currentJobName: latest?.currentJobName ?? null,
    bucketCount,
    firstStartTime,
    durationSeconds,
  };
}

// Sort order mirrors the previous DB ordering (Postgres enums order by
// declaration position; uuid ordering is byte-wise = hex-string order).
const ENTITY_TYPE_ORDER: Record<BucketEntityType, number> = { STATION: 0, WORKCENTER: 1, SITE: 2, JOB: 3 };
const GRANULARITY_ORDER: Record<BucketGranularity, number> = { MINUTE: 0, HOUR: 1, SHIFT: 2, DAY: 3 };

function compareBucketRows(a: BucketRow, b: BucketRow): number {
  return (
    ENTITY_TYPE_ORDER[a.entityType] - ENTITY_TYPE_ORDER[b.entityType] ||
    (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0) ||
    GRANULARITY_ORDER[a.granularity] - GRANULARITY_ORDER[b.granularity] ||
    a.startTime.getTime() - b.startTime.getTime()
  );
}

function rowToBucketRow(row: MetricBucketQueryRow): BucketRow {
  return {
    id: row.id,
    siteId: row.siteId,
    entityType: row.entityType,
    entityId: row.entityId,
    jobId: row.jobId,
    entityName: row.entityName,
    path: row.path,
    granularity: row.granularity,
    granularityName: row.granularityName,
    startTime: row.startTime,
    durationSeconds: row.durationSeconds,
    shiftInstanceId: row.shiftInstanceId,
    businessDate: row.businessDate,
    businessShift: row.businessShift,
    snapshot: rowToSnapshot(row),
  };
}

/**
 * Merge the per-job row family of one station-hour into a single row.
 * Post-cutover an hour has one row per (station, job|null); callers still
 * expect one row per station-hour. Additive columns are summed (per-job rows
 * partition the hour, so durations are additive too), ratios recomputed from
 * the sums, and display fields taken from the most recently updated row.
 */
function mergeStationHourGroup(rows: MetricBucketQueryRow[], siteId: string): BucketRow {
  const first = rows[0];
  const kpis: BucketKPIs = { ...ZERO_KPIS };
  let durationSeconds = 0;
  let latest = first;
  for (const row of rows) {
    for (const key of ADDITIVE_KPI_KEYS) {
      (kpis as unknown as Record<string, number>)[key] +=
        ((row as unknown as Record<string, number | null>)[key] as number | null) ?? 0;
    }
    durationSeconds += row.durationSeconds;
    if (row.updatedAt > latest.updatedAt) latest = row;
  }
  kpis.currentStandardCycle = decimalToNumber(latest.currentStandardCycle);

  const agg: BucketAggregate = {
    kpis,
    computed: computeAllKpis(kpis),
    currentStandardCycle: kpis.currentStandardCycle,
    currentJobId: latest.currentJobId ?? null,
    currentJobName: latest.currentJobName ?? null,
    bucketCount: rows.length,
    firstStartTime: first.startTime,
    durationSeconds,
  };

  return {
    id: syntheticBucketId("STATION", first.entityId, null, "HOUR", first.startTime),
    siteId,
    entityType: "STATION",
    entityId: first.entityId,
    jobId: null,
    entityName: first.entityName,
    path: first.path,
    granularity: "HOUR",
    granularityName: first.granularityName,
    startTime: first.startTime,
    durationSeconds,
    shiftInstanceId: first.shiftInstanceId,
    businessDate: first.businessDate,
    businessShift: first.businessShift,
    snapshot: aggregateToSnapshot(agg, {
      shiftInstanceId: first.shiftInstanceId,
      businessDate: first.businessDate,
      businessShift: first.businessShift,
      includeJobDisplay: true,
    }),
  };
}

/** MINUTE/HOUR requests read persisted rows; STATION hours merge the per-job family. */
async function fetchDirectBuckets(
  input: GetBucketsInput,
  entities: EntitySubscription[],
  needed: number,
): Promise<BucketRow[]> {
  if (entities.length === 0) {
    return [];
  }

  const entityConditions = entities.map((entity) => ({
    entityType: entity.entityType,
    entityId: entity.entityId,
    ...(entity.jobId != null ? { jobId: entity.jobId } : {}),
    granularity: { in: entity.granularities },
  }));

  const timeFilter: { gte?: Date; lt?: Date } | undefined =
    input.startTime || input.endTime
      ? {
          ...(input.startTime ? { gte: input.startTime } : {}),
          ...(input.endTime ? { lt: input.endTime } : {}),
        }
      : undefined;

  // Over-fetch: a station-hour may be split across several per-job rows that
  // merge into one output row, so the DB limit cannot be the final page size.
  const take = Math.min(needed * 4 + 50, 2000);

  const rows: MetricBucketQueryRow[] = await prisma.metricBucket.findMany({
    where: {
      siteId: input.siteId,
      OR: entityConditions,
      ...(timeFilter ? { startTime: timeFilter } : {}),
      ...(input.businessDate ? { businessDate: input.businessDate } : {}),
    },
    orderBy: [{ entityType: "asc" }, { entityId: "asc" }, { granularity: "asc" }, { startTime: "asc" }],
    take,
  });

  const result: BucketRow[] = [];
  const hourGroups = new Map<string, MetricBucketQueryRow[]>();
  for (const row of rows) {
    // STATION entity conditions carry no jobId predicate, so both the
    // pre-cutover whole-station row and the post-cutover per-job family
    // land here; grouping by (entityId, startTime) yields one row per
    // station-hour in every regime.
    if (row.entityType === "STATION" && row.granularity === "HOUR") {
      const key = `${row.entityId}|${row.startTime.getTime()}`;
      const group = hourGroups.get(key);
      if (group) group.push(row);
      else hourGroups.set(key, [row]);
    } else {
      result.push(rowToBucketRow(row));
    }
  }
  for (const group of hourGroups.values()) {
    result.push(mergeStationHourGroup(group, input.siteId));
  }
  return result;
}

interface DerivedEntityPlan {
  entity: EntitySubscription;
  index: number;
  stationIds: string[];
  /** Workcenter used for ShiftInstance resolution (null = site-level). */
  workCenterId: string | null;
  instances: ShiftWindow[];
}

function shiftWindowEnd(instance: ShiftWindow): Date {
  return new Date(instance.startTime.getTime() + instance.durationSeconds * 1000);
}

/**
 * SHIFT/DAY rows are no longer read from their own tiers — they are derived
 * from the entity's STATION-family hour rows via the read service, grouped
 * by shiftInstanceId (SHIFT) or businessDate (DAY). WORKCENTER/SITE slices
 * aggregate their member stations' hour rows over the shift window (member
 * stations may be stamped with workcenter-level instances that differ from
 * the entity's own, so the window predicate is the regime-proof scope).
 */
async function fetchDerivedBuckets(
  input: GetBucketsInput,
  entities: EntitySubscription[],
  needed: number,
): Promise<BucketRow[]> {
  if (entities.length === 0) {
    return [];
  }

  const ctx = new MetricsContext();

  // 1. Resolve every entity's member stations + shift-lookup workcenter.
  const stationLikeIds = [
    ...new Set(
      entities
        .filter((entity) => entity.entityType === "STATION" || entity.entityType === "JOB")
        .map((entity) => entity.entityId),
    ),
  ];
  const stationWcRows =
    stationLikeIds.length > 0
      ? await prisma.station.findMany({
          where: { id: { in: stationLikeIds } },
          select: { id: true, workcenterId: true },
        })
      : [];
  const wcByStationId = new Map(stationWcRows.map((row) => [row.id, row.workcenterId]));

  // 2. ShiftInstance windows once per distinct workcenter scope. The lookup
  //    range is padded by 36h so a partially-covered business day still sees
  //    all of its shifts; exact row filters are re-applied below.
  const PAD_MS = 36 * 60 * 60 * 1000;
  const rangeStart = new Date((input.startTime ?? new Date(0)).getTime() - PAD_MS);
  const rangeEnd = new Date((input.endTime ?? new Date()).getTime() + PAD_MS);
  const instanceCap = Math.min(needed * 2 + 10, 800);

  const instancesByWcKey = new Map<string, Promise<ShiftWindow[]>>();
  const instancesFor = (workCenterId: string | null): Promise<ShiftWindow[]> => {
    const key = workCenterId ?? "site";
    let promise = instancesByWcKey.get(key);
    if (!promise) {
      promise = getShiftInstancesForRange(input.siteId, workCenterId, rangeStart, rangeEnd).then((instances) => {
        const filtered = input.businessDate
          ? instances.filter((instance) => instance.businessDate.getTime() === input.businessDate?.getTime())
          : instances;
        return filtered.slice(0, instanceCap);
      });
      instancesByWcKey.set(key, promise);
    }
    return promise;
  };

  const plans: DerivedEntityPlan[] = await Promise.all(
    entities.map(async (entity, index) => {
      let stationIds: string[];
      let workCenterId: string | null;
      if (entity.entityType === "STATION" || entity.entityType === "JOB") {
        stationIds = [entity.entityId];
        workCenterId = wcByStationId.get(entity.entityId) ?? null;
      } else {
        stationIds = await resolveMemberStationIds(entity.entityType, entity.entityId, input.siteId);
        workCenterId = entity.entityType === "WORKCENTER" ? entity.entityId : null;
      }
      return { entity, index, stationIds, workCenterId, instances: await instancesFor(workCenterId) };
    }),
  );

  // 3. Batch the read-service calls: one aggregateStationHours /
  //    aggregateJobHours per distinct shift instance (all stations pooled),
  //    one aggregateStationTotal per (WORKCENTER/SITE entity, instance).
  const stationScopes = new Map<string, { instance: ShiftWindow; stationIds: Set<string> }>();
  const jobScopes = new Map<string, { instance: ShiftWindow; stationIds: Set<string> }>();
  const totalScopes = new Map<string, { instance: ShiftWindow; stationIds: string[] }>();

  for (const plan of plans) {
    for (const instance of plan.instances) {
      const id = instance.shiftInstanceId;
      if (plan.entity.entityType === "STATION") {
        const scope = stationScopes.get(id) ?? { instance, stationIds: new Set<string>() };
        for (const stationId of plan.stationIds) scope.stationIds.add(stationId);
        stationScopes.set(id, scope);
      } else if (plan.entity.entityType === "JOB") {
        const scope = jobScopes.get(id) ?? { instance, stationIds: new Set<string>() };
        for (const stationId of plan.stationIds) scope.stationIds.add(stationId);
        jobScopes.set(id, scope);
      } else {
        totalScopes.set(`${plan.index}|${id}`, { instance, stationIds: plan.stationIds });
      }
    }
  }

  const stationAggs = new Map<string, Map<string, BucketAggregate>>();
  const jobAggs = new Map<string, Map<string, BucketAggregate & { stationId: string; jobId: string }>>();
  const totalAggs = new Map<string, BucketAggregate>();

  await Promise.all([
    ...[...stationScopes].map(async ([id, scope]) => {
      stationAggs.set(id, await aggregateStationHours({ stationIds: [...scope.stationIds], shiftInstanceId: id }));
    }),
    ...[...jobScopes].map(async ([id, scope]) => {
      jobAggs.set(id, await aggregateJobHours({ stationIds: [...scope.stationIds], shiftInstanceId: id }));
    }),
    ...[...totalScopes].map(async ([key, scope]) => {
      totalAggs.set(
        key,
        await aggregateStationTotal({
          stationIds: scope.stationIds,
          window: { start: scope.instance.startTime, end: shiftWindowEnd(scope.instance) },
        }),
      );
    }),
  ]);

  const aggFor = (plan: DerivedEntityPlan, instance: ShiftWindow): BucketAggregate | undefined => {
    const id = instance.shiftInstanceId;
    switch (plan.entity.entityType) {
      case "STATION":
        return stationAggs.get(id)?.get(plan.entity.entityId);
      case "JOB":
        return jobAggs.get(id)?.get(`${plan.entity.entityId}|${plan.entity.jobId}`);
      default:
        return totalAggs.get(`${plan.index}|${id}`);
    }
  };

  const inStartTimeRange = (startTime: Date): boolean => {
    if (input.startTime && startTime < input.startTime) return false;
    if (input.endTime && startTime >= input.endTime) return false;
    return true;
  };

  // 4. Assemble derived rows.
  const result: BucketRow[] = [];
  for (const plan of plans) {
    const { entity } = plan;
    if (plan.instances.length === 0) continue;

    const includeJobDisplay = entity.entityType === "STATION" || entity.entityType === "JOB";
    const { entityName, path } = await resolveMetadata(
      input.siteId,
      entity.entityType,
      entity.entityId,
      undefined,
      undefined,
      ctx,
      entity.jobId,
    );
    const base = {
      siteId: input.siteId,
      entityType: entity.entityType,
      entityId: entity.entityId,
      jobId: entity.jobId ?? null,
      entityName,
      path,
    };

    if (entity.granularities.includes("SHIFT")) {
      for (const instance of plan.instances) {
        if (!inStartTimeRange(instance.startTime)) continue;
        const agg = aggFor(plan, instance);
        if (!agg || agg.bucketCount === 0) continue;
        result.push({
          ...base,
          id: syntheticBucketId(entity.entityType, entity.entityId, entity.jobId, "SHIFT", instance.startTime),
          granularity: "SHIFT",
          granularityName: instance.shiftName,
          startTime: instance.startTime,
          durationSeconds: agg.durationSeconds,
          shiftInstanceId: instance.shiftInstanceId,
          businessDate: instance.businessDate,
          businessShift: instance.shiftName,
          snapshot: aggregateToSnapshot(agg, {
            shiftInstanceId: instance.shiftInstanceId,
            businessDate: instance.businessDate,
            businessShift: instance.shiftName,
            includeJobDisplay,
          }),
        });
      }
    }

    if (entity.granularities.includes("DAY")) {
      const byBusinessDate = new Map<number, ShiftWindow[]>();
      for (const instance of plan.instances) {
        const key = instance.businessDate.getTime();
        const list = byBusinessDate.get(key);
        if (list) list.push(instance);
        else byBusinessDate.set(key, [instance]);
      }

      for (const [businessDateMs, instances] of byBusinessDate) {
        const dayStart = instances.reduce(
          (min, instance) => (instance.startTime < min ? instance.startTime : min),
          instances[0].startTime,
        );
        if (!inStartTimeRange(dayStart)) continue;
        const combined = combineAggregates(
          instances.map((instance) => aggFor(plan, instance)).filter((agg): agg is BucketAggregate => agg != null),
        );
        if (combined.bucketCount === 0) continue;
        const businessDate = new Date(businessDateMs);
        result.push({
          ...base,
          id: syntheticBucketId(entity.entityType, entity.entityId, entity.jobId, "DAY", dayStart),
          granularity: "DAY",
          granularityName: "Day",
          startTime: dayStart,
          durationSeconds: combined.durationSeconds,
          shiftInstanceId: null,
          businessDate,
          businessShift: null,
          snapshot: aggregateToSnapshot(combined, {
            shiftInstanceId: null,
            businessDate,
            businessShift: null,
            includeJobDisplay,
          }),
        });
      }
    }
  }

  return result;
}

export async function getBuckets(input: GetBucketsInput): Promise<BucketRow[]> {
  if (input.entities.length === 0) {
    return [];
  }

  const limit = input.limit ?? 200;
  const offset = input.offset ?? 0;
  const needed = offset + limit;

  // MINUTE/HOUR are the persisted grains (read directly, with the per-job
  // hour family merged); SHIFT/DAY are derived from hour rows at read time.
  const directEntities = input.entities
    .map((entity) => ({
      ...entity,
      granularities: entity.granularities.filter((g) => g === "MINUTE" || g === "HOUR"),
    }))
    .filter((entity) => entity.granularities.length > 0);
  const derivedEntities = input.entities
    .map((entity) => ({
      ...entity,
      granularities: entity.granularities.filter((g) => g === "SHIFT" || g === "DAY"),
    }))
    .filter((entity) => entity.granularities.length > 0);

  const [directRows, derivedRows] = await Promise.all([
    fetchDirectBuckets(input, directEntities, needed),
    fetchDerivedBuckets(input, derivedEntities, needed),
  ]);

  return [...directRows, ...derivedRows].sort(compareBucketRows).slice(offset, needed);
}

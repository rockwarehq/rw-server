import { ORPCError } from "@orpc/server";
import * as z from "zod";
import prisma from "@rw/db";
import { Principal } from "../auth/index.js";
import { METRIC_CATALOG_REGISTRY } from "@rw/services/metric-catalog/index";
import { MetricsContext } from "@rw/services/metrics/context";
import * as query from "../services/metrics.js";
import {
  aggregateJobHours,
  aggregateStationHours,
  aggregateStationTotal,
  type BucketAggregate,
} from "@rw/services/metrics/read";
import { getShiftForEntity, type ShiftWindow } from "@rw/services/metrics/shift";
import type { rowToSnapshot } from "@rw/services/metrics/sync";
import { userOrDisplayRequired } from "./middleware.js";

const entityTypeSchema = z.enum(["STATION", "WORKCENTER", "SITE", "JOB"]);
const granularitySchema = z.enum(["MINUTE", "HOUR", "SHIFT", "DAY"]);

// JOB buckets are keyed by (entityId = station id, jobId = job id), so JOB
// entity references must carry a jobId — enforced by assertJobEntity below.
const entitySubscriptionSchema = z.object({
  entityType: entityTypeSchema,
  entityId: z.uuid(),
  jobId: z.uuid().optional(),
  granularities: z.array(granularitySchema).min(1),
});

/** JOB entity references require a jobId; other entity types must not carry one. */
function assertJobEntity(entity: { entityType: z.infer<typeof entityTypeSchema>; jobId?: string | null }): void {
  if (entity.entityType === "JOB" && entity.jobId == null) {
    throw new ORPCError("BAD_REQUEST", { message: "jobId is required for JOB entities" });
  }
  if (entity.entityType !== "JOB" && entity.jobId != null) {
    throw new ORPCError("BAD_REQUEST", { message: "jobId is only valid for JOB entities" });
  }
}

const snapshotSchema = z.object({
  totalCycles: z.number(),
  goodCycles: z.number(),
  badCycles: z.number(),
  totalItems: z.number(),
  goodItems: z.number(),
  badItems: z.number(),
  expectedCycles: z.number(),
  expectedItems: z.number(),
  runSeconds: z.number(),
  downSeconds: z.number(),
  plannedDownSeconds: z.number(),
  unplannedDownSeconds: z.number(),
  plannedProductionSeconds: z.number(),
  idealCycleSeconds: z.number(),
  totalCycleSeconds: z.number(),
  elapsedExpectedCycles: z.number(),
  elapsedExpectedItems: z.number(),
  elapsedPlannedProductionSeconds: z.number(),
  currentStandardCycle: z.number().nullable(),
  availability: z.number().nullable(),
  performance: z.number().nullable(),
  quality: z.number().nullable(),
  oee: z.number().nullable(),
  shiftInstanceId: z.uuid().nullable(),
});

const bucketSchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  entityType: entityTypeSchema,
  entityId: z.uuid(),
  jobId: z.uuid().nullable(),
  entityName: z.string(),
  path: z.string(),
  granularity: granularitySchema,
  granularityName: z.string(),
  startTime: z.iso.datetime(),
  durationSeconds: z.number(),
  shiftInstanceId: z.uuid().nullable(),
  businessDate: z.iso.datetime().nullable(),
  businessShift: z.string().nullable(),
  snapshot: snapshotSchema,
});

const getBucketsInputSchema = z.object({
  siteId: z.uuid(),
  entities: z.array(entitySubscriptionSchema).min(1),
  startTime: z.iso.datetime().optional(),
  endTime: z.iso.datetime().optional(),
  businessDate: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(500).default(200),
  offset: z.number().int().min(0).default(0),
});

const shiftValueEntitySchema = z.object({
  entityType: entityTypeSchema,
  entityId: z.uuid(),
  jobId: z.uuid().optional(),
});

const getShiftValuesInputSchema = z.object({
  siteId: z.uuid(),
  entities: z.array(shiftValueEntitySchema).min(1),
  metricKeys: z.array(z.string().min(1)).min(1),
  timestamp: z.iso.datetime().optional(),
});

const shiftValueSchema = z
  .object({
    startTime: z.iso.datetime(),
    durationSeconds: z.number(),
    shiftInstanceId: z.uuid().nullable(),
    businessDate: z.iso.datetime().nullable(),
    businessShift: z.string().nullable(),
  })
  .nullable();

const getShiftValuesRowSchema = z.object({
  entityType: entityTypeSchema,
  entityId: z.uuid(),
  jobId: z.uuid().nullish(),
  shift: shiftValueSchema,
  values: z.record(z.string(), z.number().nullable()),
});

const getShiftValuesOutputSchema = z.object({
  data: z.array(getShiftValuesRowSchema),
});

async function assertSiteAccess(siteId: string, workspaceId: string): Promise<void> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { workspaceId: true },
  });

  if (!site) {
    throw new ORPCError("NOT_FOUND", { message: "Site not found" });
  }

  if (site.workspaceId !== workspaceId) {
    throw new ORPCError("FORBIDDEN", { message: "Site does not belong to this workspace" });
  }
}

async function assertRuntimeSiteAccess(
  iam: { principal: string; workspaceId?: string; siteId?: string },
  siteId: string,
): Promise<void> {
  if (iam.principal === Principal.DISPLAY) {
    if (iam.siteId !== siteId) {
      throw new ORPCError("FORBIDDEN", { message: "Display can only access metrics for its site" });
    }

    return;
  }

  if (!iam.workspaceId) {
    throw new ORPCError("UNAUTHORIZED", { message: "Workspace context required" });
  }

  await assertSiteAccess(siteId, iam.workspaceId);
}

export const getBuckets = userOrDisplayRequired
  .input(getBucketsInputSchema)
  .output(z.array(bucketSchema))
  .handler(async ({ context, input }) => {
    await assertRuntimeSiteAccess(context.iam, input.siteId);

    for (const entity of input.entities) {
      assertJobEntity(entity);
    }

    const buckets = await query.getBuckets({
      siteId: input.siteId,
      entities: input.entities,
      startTime: input.startTime ? new Date(input.startTime) : undefined,
      endTime: input.endTime ? new Date(input.endTime) : undefined,
      businessDate: input.businessDate ? new Date(input.businessDate) : undefined,
      limit: input.limit,
      offset: input.offset,
    });

    return buckets.map((bucket) => ({
      ...bucket,
      startTime: bucket.startTime.toISOString(),
      businessDate: bucket.businessDate?.toISOString() ?? null,
    }));
  });

const SHIFT_METRIC_CATALOG_MAP = new Map(
  METRIC_CATALOG_REGISTRY.filter((definition) =>
    definition.granularities.some((granularity) => granularity === "SHIFT"),
  ).map((definition) => [definition.key, definition]),
);

type ShiftSnapshot = ReturnType<typeof rowToSnapshot>;
type ShiftMetricKey = (typeof METRIC_CATALOG_REGISTRY)[number]["key"];

export const getShiftValues = userOrDisplayRequired
  .input(getShiftValuesInputSchema)
  .output(getShiftValuesOutputSchema)
  .handler(async ({ context, input }) => {
    await assertRuntimeSiteAccess(context.iam, input.siteId);

    const uniqueMetricKeys = [...new Set(input.metricKeys)] as ShiftMetricKey[];

    for (const key of uniqueMetricKeys) {
      const definition = SHIFT_METRIC_CATALOG_MAP.get(key);
      if (!definition) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Metric key '${key}' is not available for SHIFT granularity`,
        });
      }

      const unsupportedEntityType = input.entities.find(
        (entity) => !definition.entityTypes.some((entityType) => entityType === entity.entityType),
      )?.entityType;

      if (unsupportedEntityType) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Metric key '${key}' does not support entity type '${unsupportedEntityType}'`,
        });
      }
    }

    for (const entity of input.entities) {
      assertJobEntity(entity);
    }

    const timestamp = input.timestamp ? new Date(input.timestamp) : new Date();
    const metricCtx = new MetricsContext();

    const resolvedShifts = await Promise.all(
      input.entities.map((entity) =>
        getShiftForEntity(entity.entityType, entity.entityId, input.siteId, timestamp, metricCtx),
      ),
    );

    // Star-schema Stage B: SHIFT values are no longer read from persisted
    // SHIFT-tier rows — they are summed from the STATION-family hour rows via
    // the read service; the four ratios come from the aggregate's `computed`
    // block (recomputed from summed ingredients, never summed themselves).
    //
    // Batching: STATION and JOB entities pool into one read-service call per
    // distinct shift instance; each WORKCENTER/SITE entity aggregates its
    // member stations over the shift window (member stations may be stamped
    // with workcenter-level instances that differ from the entity's own
    // resolved instance, so the window predicate is the regime-proof scope).
    const stationsByShift = new Map<string, Set<string>>();
    const jobStationsByShift = new Map<string, Set<string>>();
    input.entities.forEach((entity, index) => {
      const shift = resolvedShifts[index];
      if (!shift) return;
      if (entity.entityType === "STATION") {
        const stations = stationsByShift.get(shift.shiftInstanceId) ?? new Set<string>();
        stations.add(entity.entityId);
        stationsByShift.set(shift.shiftInstanceId, stations);
      } else if (entity.entityType === "JOB") {
        const stations = jobStationsByShift.get(shift.shiftInstanceId) ?? new Set<string>();
        stations.add(entity.entityId);
        jobStationsByShift.set(shift.shiftInstanceId, stations);
      }
    });

    const stationAggs = new Map<string, Map<string, BucketAggregate>>();
    const jobAggs = new Map<string, Map<string, BucketAggregate & { stationId: string; jobId: string }>>();
    const totalAggs = new Map<number, BucketAggregate>();

    const shiftWindowOf = (shift: ShiftWindow) => ({
      start: shift.startTime,
      end: new Date(shift.startTime.getTime() + shift.durationSeconds * 1000),
    });

    // overlayNow: current-shift numbers must be live — open hour rows'
    // duration/elapsed columns are computed at read time (Stage D), the
    // stored values only advance on transitions and at hour close.
    const overlayNow = new Date();
    await Promise.all([
      ...[...stationsByShift].map(async ([shiftInstanceId, stations]) => {
        stationAggs.set(
          shiftInstanceId,
          await aggregateStationHours({ stationIds: [...stations], shiftInstanceId }, { overlayNow }),
        );
      }),
      ...[...jobStationsByShift].map(async ([shiftInstanceId, stations]) => {
        jobAggs.set(
          shiftInstanceId,
          await aggregateJobHours({ stationIds: [...stations], shiftInstanceId }, undefined, { overlayNow }),
        );
      }),
      ...input.entities.map(async (entity, index) => {
        if (entity.entityType !== "WORKCENTER" && entity.entityType !== "SITE") return;
        const shift = resolvedShifts[index];
        if (!shift) return;
        const stationIds = await query.resolveMemberStationIds(entity.entityType, entity.entityId, input.siteId);
        totalAggs.set(index, await aggregateStationTotal({ stationIds, window: shiftWindowOf(shift) }, { overlayNow }));
      }),
    ]);

    const data = input.entities.map((entity, index) => {
      const shift = resolvedShifts[index];
      const empty = {
        entityType: entity.entityType,
        entityId: entity.entityId,
        jobId: entity.jobId ?? null,
        shift: null,
        values: {},
      };
      if (!shift) return empty;

      let aggregate: BucketAggregate | undefined;
      switch (entity.entityType) {
        case "STATION":
          aggregate = stationAggs.get(shift.shiftInstanceId)?.get(entity.entityId);
          break;
        case "JOB":
          aggregate = jobAggs.get(shift.shiftInstanceId)?.get(`${entity.entityId}|${entity.jobId}`);
          break;
        default:
          aggregate = totalAggs.get(index);
          break;
      }

      // No contributing hour rows — mirrors the previous "no SHIFT row" case.
      if (!aggregate || aggregate.bucketCount === 0) return empty;

      const snapshot: ShiftSnapshot = query.aggregateToSnapshot(aggregate, {
        shiftInstanceId: shift.shiftInstanceId,
        businessDate: shift.businessDate,
        businessShift: shift.shiftName,
        includeJobDisplay: entity.entityType === "STATION" || entity.entityType === "JOB",
      });

      const values: Record<string, number | null> = {};
      for (const key of uniqueMetricKeys) {
        values[key] = snapshot[key as keyof ShiftSnapshot] as number | null;
      }

      return {
        entityType: entity.entityType,
        entityId: entity.entityId,
        jobId: entity.jobId ?? null,
        shift: {
          startTime: shift.startTime.toISOString(),
          durationSeconds: shift.durationSeconds,
          shiftInstanceId: shift.shiftInstanceId,
          businessDate: shift.businessDate.toISOString(),
          businessShift: shift.shiftName,
        },
        values,
      };
    });

    return { data };
  });

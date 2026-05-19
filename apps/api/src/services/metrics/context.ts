// ── Per-pipeline metrics context ─────────────────────────────────
// A short-lived cache object created once per pipeline execution
// (cycle completion, background worker tick, etc.) and threaded
// through all metrics functions. Eliminates redundant DB lookups
// within a single pipeline run.
//
// The cache is NOT shared across pipelines — each pipeline creates
// its own MetricsContext so data is always fresh at the start.

import type { ShiftWindow, HourBucket } from "./shift.js";
import type { IncrementTarget } from "./hierarchy.js";

// ── Types ────────────────────────────────────────────────────────

type EntityType = "STATION" | "WORKCENTER" | "SITE" | "JOB";

// ── Cache key helpers ────────────────────────────────────────────

function shiftKey(entityType: EntityType, entityId: string, siteId: string, timestampMs: number): string {
  return `${entityType}:${entityId}:${siteId}:${timestampMs}`;
}

function anchorKey(shiftStartMs: number, siteId: string, workCenterId: string | null): string {
  return `${shiftStartMs}:${siteId}:${workCenterId ?? "null"}`;
}

function hourBucketKey(entityType: EntityType, entityId: string, siteId: string, timestampMs: number): string {
  return `hb:${entityType}:${entityId}:${siteId}:${timestampMs}`;
}

function hourBucketsKey(entityType: EntityType, entityId: string, siteId: string, timestampMs: number): string {
  return `hbs:${entityType}:${entityId}:${siteId}:${timestampMs}`;
}

function workCenterIdKey(entityType: EntityType, entityId: string): string {
  return `wc:${entityType}:${entityId}`;
}

function childStationsKey(entityType: EntityType, entityId: string): string {
  return `cs:${entityType}:${entityId}`;
}

// ── Sentinel for cached null values ──────────────────────────────
// We use a sentinel to distinguish "not cached" from "cached null".

const NULL_SENTINEL = Symbol("cachedNull");
type Cached<T> = T | typeof NULL_SENTINEL;

function unwrap<T>(val: Cached<T>): T | null {
  return val === NULL_SENTINEL ? null : val;
}

function wrap<T>(val: T | null): Cached<T> {
  return val === null ? NULL_SENTINEL : val;
}

// ── MetricsContext ───────────────────────────────────────────────

/**
 * Per-pipeline cache for metrics computations.
 *
 * Create one at the start of a pipeline run and pass it to all
 * metrics functions. All lookups are cached for the lifetime of
 * the context.
 *
 * Usage:
 * ```ts
 * const ctx = new MetricsContext();
 * await updateCountBased(stationId, siteId, timestamp, ctx);
 * ```
 */
export class MetricsContext {
  // ── Shift lookups ────────────────────────────────────────────
  private shifts = new Map<string, Cached<ShiftWindow>>();

  getShiftCached(
    entityType: EntityType,
    entityId: string,
    siteId: string,
    timestamp: Date,
  ): ShiftWindow | null | undefined {
    const key = shiftKey(entityType, entityId, siteId, timestamp.getTime());
    const cached = this.shifts.get(key);
    if (cached === undefined) return undefined; // not cached
    return unwrap(cached);
  }

  setShiftCached(
    entityType: EntityType,
    entityId: string,
    siteId: string,
    timestamp: Date,
    value: ShiftWindow | null,
  ): void {
    const key = shiftKey(entityType, entityId, siteId, timestamp.getTime());
    this.shifts.set(key, wrap(value));
  }

  // ── Anchor time lookups ──────────────────────────────────────
  private anchors = new Map<string, Date>();

  getAnchorCached(shift: ShiftWindow, siteId: string, workCenterId: string | null): Date | undefined {
    return this.anchors.get(anchorKey(shift.startTime.getTime(), siteId, workCenterId));
  }

  setAnchorCached(shift: ShiftWindow, siteId: string, workCenterId: string | null, value: Date): void {
    this.anchors.set(anchorKey(shift.startTime.getTime(), siteId, workCenterId), value);
  }

  // ── Hour bucket resolution (single) ──────────────────────────
  private hourBucketCache = new Map<string, HourBucket>();

  getHourBucketCached(
    entityType: EntityType,
    entityId: string,
    siteId: string,
    timestamp: Date,
  ): HourBucket | undefined {
    return this.hourBucketCache.get(hourBucketKey(entityType, entityId, siteId, timestamp.getTime()));
  }

  setHourBucketCached(
    entityType: EntityType,
    entityId: string,
    siteId: string,
    timestamp: Date,
    value: HourBucket,
  ): void {
    this.hourBucketCache.set(hourBucketKey(entityType, entityId, siteId, timestamp.getTime()), value);
  }

  // ── Hour buckets (all for an entity at a timestamp) ──────────
  private hourBucketsCache = new Map<string, HourBucket[]>();

  getHourBucketsCached(
    entityType: EntityType,
    entityId: string,
    siteId: string,
    timestamp: Date,
  ): HourBucket[] | undefined {
    return this.hourBucketsCache.get(hourBucketsKey(entityType, entityId, siteId, timestamp.getTime()));
  }

  setHourBucketsCached(
    entityType: EntityType,
    entityId: string,
    siteId: string,
    timestamp: Date,
    value: HourBucket[],
  ): void {
    this.hourBucketsCache.set(hourBucketsKey(entityType, entityId, siteId, timestamp.getTime()), value);
  }

  // ── Workcenter ID resolution ─────────────────────────────────
  private workCenterIds = new Map<string, Cached<string>>();

  getWorkCenterIdCached(entityType: EntityType, entityId: string): string | null | undefined {
    const cached = this.workCenterIds.get(workCenterIdKey(entityType, entityId));
    if (cached === undefined) return undefined;
    return unwrap(cached);
  }

  setWorkCenterIdCached(entityType: EntityType, entityId: string, value: string | null): void {
    this.workCenterIds.set(workCenterIdKey(entityType, entityId), wrap(value));
  }

  // ── Timezone lookups ─────────────────────────────────────────
  private timezones = new Map<string, string>();

  getTimezoneCached(siteId: string): string | undefined {
    return this.timezones.get(siteId);
  }

  setTimezoneCached(siteId: string, value: string): void {
    this.timezones.set(siteId, value);
  }

  // ── Hierarchy targets ────────────────────────────────────────
  private incrementTargets = new Map<string, IncrementTarget[]>();

  getIncrementTargetsCached(stationId: string, siteId: string): IncrementTarget[] | undefined {
    return this.incrementTargets.get(`${stationId}:${siteId}`);
  }

  setIncrementTargetsCached(stationId: string, siteId: string, value: IncrementTarget[]): void {
    this.incrementTargets.set(`${stationId}:${siteId}`, value);
  }

  // ── Entity path/name resolution ──────────────────────────────
  private entityPaths = new Map<string, string>();
  private entityNames = new Map<string, string>();

  getEntityPathCached(entityType: EntityType, entityId: string, siteId: string): string | undefined {
    return this.entityPaths.get(`${entityType}:${entityId}:${siteId}`);
  }

  setEntityPathCached(entityType: EntityType, entityId: string, siteId: string, value: string): void {
    this.entityPaths.set(`${entityType}:${entityId}:${siteId}`, value);
  }

  getEntityNameCached(entityType: EntityType, entityId: string): string | undefined {
    return this.entityNames.get(`${entityType}:${entityId}`);
  }

  setEntityNameCached(entityType: EntityType, entityId: string, value: string): void {
    this.entityNames.set(`${entityType}:${entityId}`, value);
  }

  // ── Child station IDs ────────────────────────────────────────
  private childStations = new Map<string, string[]>();

  getChildStationIdsCached(entityType: EntityType, entityId: string): string[] | undefined {
    return this.childStations.get(childStationsKey(entityType, entityId));
  }

  setChildStationIdsCached(entityType: EntityType, entityId: string, value: string[]): void {
    this.childStations.set(childStationsKey(entityType, entityId), value);
  }
}

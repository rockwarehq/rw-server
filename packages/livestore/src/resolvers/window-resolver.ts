import type { AggStateStore } from "../value/agg-store.js";
import { buildEwmaEnvelope, buildTumblingEnvelope } from "./window-envelope.js";
import { bucketStartFor, foldEwmaSample, foldTumblingSample, initEwmaState, initTumblingState } from "./window-fold.js";
import { validateWindowResolver } from "./window-validate.js";
import {
  isWindowResolverConfig,
  worse,
  type Aggregation,
  type EwmaState,
  type LivestoreLogger,
  type PropertyRuntime,
  type TumblingState,
  type ValueEnvelope,
  type WindowResolverConfig,
} from "../value/types.js";

export interface WindowCommitSink {
  commitValue(propertyId: string, envelope: ValueEnvelope, source: "window"): Promise<void>;
}

export type WindowStateStore = Pick<AggStateStore, "get" | "put">;

const PERSIST_DEBOUNCE_MS = 500;
const EWMA_STALE_AFTER_MS = 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

interface BaseRuntime {
  propertyId: string;
  persistTimer: ReturnType<typeof setTimeout> | null;
  emitChain: Promise<void>;
}

interface TumblingRuntime extends BaseRuntime {
  kind: "tumbling";
  windowMs: number;
  alignToMs: number;
  aggregation: Aggregation;
  state: TumblingState;
  closeTimer: ReturnType<typeof setTimeout> | null;
  lateWarnBucketStart: number;
}

interface EwmaRuntime extends BaseRuntime {
  kind: "ewma";
  alpha: number;
  state: EwmaState;
}

type WindowRuntime = TumblingRuntime | EwmaRuntime;

// folds live samples into agg state
// closes tumbling buckets on timers
// rehydrates across restarts.
export class WindowResolver {
  private readonly bySource = new Map<string, WindowRuntime[]>();
  private readonly byId = new Map<string, WindowRuntime>();
  private stopped = false;
  private lateSamplesDropped = 0;
  private gapBucketsSkipped = 0;

  constructor(
    private readonly store: WindowStateStore,
    private readonly sink: WindowCommitSink,
    private readonly logger: LivestoreLogger,
    private readonly now: () => number = Date.now,
  ) {}

  async start(
    properties: Iterable<PropertyRuntime>,
    getProperty: (id: string) => { resolverType: string } | null,
  ): Promise<void> {
    this.stopped = false;
    for (const property of properties) {
      await this.upsertProperty(property, getProperty);
    }
    this.logger.info({ windowCount: this.byId.size }, "livestore window resolver started");
  }

  async upsertProperty(
    property: PropertyRuntime,
    getProperty: (id: string) => { resolverType: string } | null,
  ): Promise<void> {
    await this.removeProperty(property.id);
    if (!isWindowResolverConfig(property.resolver)) return;

    const errors = validateWindowResolver(property.resolver, getProperty);
    if (errors.length > 0) {
      this.logger.warn({ propertyId: property.id, errors }, "livestore window skipped: invalid resolver");
      return;
    }

    const rt = await this.rehydrate(property.id, property.resolver);
    this.byId.set(property.id, rt);
    const siblings = this.bySource.get(property.resolver.sourcePropertyId) ?? [];
    siblings.push(rt);
    this.bySource.set(property.resolver.sourcePropertyId, siblings);
  }

  async removeProperty(propertyId: string): Promise<void> {
    const rt = this.byId.get(propertyId);
    if (!rt) return;
    this.byId.delete(propertyId);

    for (const [sourcePropertyId, windows] of this.bySource) {
      const next = windows.filter((window) => window.propertyId !== propertyId);
      if (next.length > 0) this.bySource.set(sourcePropertyId, next);
      else this.bySource.delete(sourcePropertyId);
    }

    if (rt.kind === "tumbling" && rt.closeTimer) clearTimeout(rt.closeTimer);
    if (rt.persistTimer) clearTimeout(rt.persistTimer);
    rt.persistTimer = null;
    await rt.emitChain;
    await this.store.put(rt.propertyId, rt.state);
  }

  // Synchronous by design
  onInput(sourcePropertyId: string, input: ValueEnvelope): void {
    if (this.stopped) return;
    const windows = this.bySource.get(sourcePropertyId);
    if (!windows) return;

    for (const rt of windows) {
      if (rt.kind === "ewma") {
        const next = foldEwmaSample(rt.state, input, rt.alpha);
        if (next === rt.state) continue; // unusable sample dropped
        rt.state = next;
        this.emit(rt, buildEwmaEnvelope(next)); // EWMA emits on every input
        this.schedulePersist(rt);
        continue;
      }

      if (input.timestamp < rt.state.bucketStart) {
        this.lateSamplesDropped += 1;
        if (rt.lateWarnBucketStart !== rt.state.bucketStart) {
          rt.lateWarnBucketStart = rt.state.bucketStart;
          this.logger.warn(
            { propertyId: rt.propertyId, inputTs: input.timestamp, bucketStart: rt.state.bucketStart },
            "livestore window dropping late samples",
          );
        }
        continue;
      }
      if (input.timestamp >= rt.state.bucketEnd) this.catchUp(rt, input.timestamp);
      rt.state = foldTumblingSample(rt.state, input);
      this.schedulePersist(rt);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const runtimes = [...this.byId.values()];
    for (const rt of runtimes) {
      if (rt.kind === "tumbling" && rt.closeTimer) clearTimeout(rt.closeTimer);
      if (rt.persistTimer) clearTimeout(rt.persistTimer);
      rt.persistTimer = null;
    }
    await Promise.allSettled(runtimes.map((rt) => rt.emitChain));
    // Final state flush (§17.7 graceful shutdown).
    const results = await Promise.allSettled(runtimes.map((rt) => this.store.put(rt.propertyId, rt.state)));
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) this.logger.error({ failed }, "livestore window state flush failed on shutdown");
    this.byId.clear();
    this.bySource.clear();
  }

  counts(): { windowCount: number; lateSamplesDropped: number; gapBucketsSkipped: number } {
    return {
      windowCount: this.byId.size,
      lateSamplesDropped: this.lateSamplesDropped,
      gapBucketsSkipped: this.gapBucketsSkipped,
    };
  }

  // Restart loads persisted state into agg state
  private async rehydrate(propertyId: string, config: WindowResolverConfig): Promise<WindowRuntime> {
    const persisted = await this.store.get(propertyId);

    if (config.kind === "ewma") {
      const state = persisted?.kind === "ewma" ? persisted : initEwmaState();
      const rt: EwmaRuntime = {
        kind: "ewma",
        propertyId,
        alpha: config.alpha as number,
        state,
        persistTimer: null,
        emitChain: Promise.resolve(),
      };
      // Long-idle EWMA resumes, but reads stale until a fresh input arrives.
      if (state.lastInputTs > 0 && this.now() - state.lastInputTs > EWMA_STALE_AFTER_MS) {
        this.emit(rt, { ...buildEwmaEnvelope(state), quality: worse(state.lastInputQuality, "stale") });
      }
      return rt;
    }

    const windowMs = config.windowMs as number;
    const alignToMs = config.alignToMs ?? 0;
    const now = this.now();
    const onGrid =
      persisted?.kind === "tumbling" &&
      persisted.bucketEnd === persisted.bucketStart + windowMs &&
      (persisted.bucketStart - alignToMs) % windowMs === 0;
    if (persisted && !onGrid) {
      this.logger.warn({ propertyId }, "livestore window state discarded (kind or bucket grid changed)");
    }
    const rt: TumblingRuntime = {
      kind: "tumbling",
      propertyId,
      windowMs,
      alignToMs,
      aggregation: config.aggregation,
      state: onGrid ? persisted : initTumblingState(bucketStartFor(now, windowMs, alignToMs), windowMs),
      closeTimer: null,
      lateWarnBucketStart: -1,
      persistTimer: null,
      emitChain: Promise.resolve(),
    };
    // Bucket closed while we were down: emit it as stale, then open the live one.
    if (now >= rt.state.bucketEnd) this.catchUp(rt, now, "stale");
    else this.scheduleClose(rt);
    return rt;
  }

  //bucket time is up, publish, start current bucket, schedule next close.
  private catchUp(rt: TumblingRuntime, targetTs: number, staleness?: "stale"): void {
    if (targetTs < rt.state.bucketEnd) return; // defensive: every caller checks first
    if (rt.closeTimer) {
      clearTimeout(rt.closeTimer);
      rt.closeTimer = null;
    }

    const closed = buildTumblingEnvelope(rt.state, rt.aggregation, rt.state.bucketEnd);
    this.emit(rt, staleness ? { ...closed, quality: worse(closed.quality, "stale") } : closed);

    const nextStart = bucketStartFor(targetTs, rt.windowMs, rt.alignToMs);
    const gapBuckets = (nextStart - rt.state.bucketEnd) / rt.windowMs;
    if (gapBuckets > 0) {
      this.gapBucketsSkipped += gapBuckets;
      const lastGap = initTumblingState(nextStart - rt.windowMs, rt.windowMs);
      const gapEnvelope = buildTumblingEnvelope(lastGap, rt.aggregation, lastGap.bucketEnd);
      this.emit(rt, { ...gapEnvelope, context: { ...gapEnvelope.context, gapBuckets } });
    }

    rt.state = initTumblingState(nextStart, rt.windowMs);
    this.persistNow(rt); // bucket close persists immediately (§17.7)
    this.scheduleClose(rt);
  }

  private scheduleClose(rt: TumblingRuntime): void {
    if (this.stopped) return;
    const delay = Math.min(Math.max(rt.state.bucketEnd - this.now(), 0), MAX_TIMEOUT_MS);
    // Identity guard: a fast-close can advance the bucket while this timer's macrotask
    // is already queued (unclearable). Close only the bucket the timer was armed for.
    const expectedEnd = rt.state.bucketEnd;
    rt.closeTimer = setTimeout(() => {
      rt.closeTimer = null;
      if (this.stopped || rt.state.bucketEnd !== expectedEnd) return;
      const now = this.now();
      if (now < rt.state.bucketEnd) {
        this.scheduleClose(rt); // clamped or early fire — re-arm for the remainder
        return;
      }
      this.catchUp(rt, now);
    }, delay);
  }

  // Commits for one window serialize on its chain; failures are contained there.
  private emit(rt: WindowRuntime, envelope: ValueEnvelope): void {
    rt.emitChain = rt.emitChain
      .then(() => this.sink.commitValue(rt.propertyId, envelope, "window"))
      .catch((err) => this.logger.error({ err, propertyId: rt.propertyId }, "livestore window emit failed"));
  }

  // Debounced persistence (§17.7): memory is authoritative; KV sees at most one write
  // per window per 500ms. The timer reads rt.state at fire time — always the latest fold.
  private schedulePersist(rt: WindowRuntime): void {
    if (this.stopped || rt.persistTimer) return;
    rt.persistTimer = setTimeout(() => {
      rt.persistTimer = null;
      this.persistNow(rt);
    }, PERSIST_DEBOUNCE_MS);
  }

  private persistNow(rt: WindowRuntime): void {
    if (rt.persistTimer) {
      clearTimeout(rt.persistTimer);
      rt.persistTimer = null;
    }
    void this.store
      .put(rt.propertyId, rt.state)
      .catch((err) => this.logger.error({ err, propertyId: rt.propertyId }, "livestore window state persist failed"));
  }
}

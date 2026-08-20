import type { AggStateStore } from "../store/agg-store.js";
import type { GraphHookCondition } from "../catalog/hook-conditions.js";
import {
  buildTotalizerEnvelope,
  foldTotalizerReset,
  foldTotalizerSource,
  foldTotalizerTrigger,
  initTotalizerState,
  validateTotalizerResolver,
} from "./totalizer.js";
import { buildEwmaEnvelope, buildTumblingEnvelope } from "./window-envelope.js";
import { bucketStartFor, foldEwmaSample, foldTumblingSample, initEwmaState, initTumblingState } from "./window-fold.js";
import { validateWindowResolver } from "./window-validate.js";
import { parseGraphHookCondition } from "../catalog/hook-conditions.js";
import {
  isTotalizerResolverConfig,
  isWindowResolverConfig,
  worse,
  type AggState,
  type Aggregation,
  type EwmaState,
  type LivestoreLogger,
  type PropertyRuntime,
  type TotalizerResolverConfig,
  type TotalizerState,
  type TumblingState,
  type ValueEnvelope,
  type WindowResolverConfig,
} from "../types/index.js";

export interface FoldCommitSink {
  commitValue(propertyId: string, envelope: ValueEnvelope, source: "window" | "totalizer"): Promise<void>;
}

export type FoldStateStore = Pick<AggStateStore, "get" | "put">;

const PERSIST_DEBOUNCE_MS = 500;
const EWMA_STALE_AFTER_MS = 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

interface BaseRuntime {
  propertyId: string;
  sourcePropertyId: string;
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

interface TotalizerRuntime extends BaseRuntime {
  kind: "totalizer";
  trigger: GraphHookCondition;
  triggerPropertyId: string;
  reset: GraphHookCondition | null;
  resetPropertyId: string | null;
  state: TotalizerState;
  staleWarnTriggerTs: number;
  staleWarnResetTs: number;
}

type FoldRuntime = TumblingRuntime | EwmaRuntime | TotalizerRuntime;

export type FoldInputProperty = { resolverType: string; current?: ValueEnvelope };

// Shared engine for the stateful fold resolvers (window + totalizer):
// folds live samples into KV-persisted agg state,
// closes tumbling buckets on timers, adds totalizer trigger firings,
// rehydrates across restarts.
export class FoldResolver {
  private readonly bySource = new Map<string, FoldRuntime[]>();
  private readonly byId = new Map<string, FoldRuntime>();
  private stopped = false;
  private lateSamplesDropped = 0;
  private gapBucketsSkipped = 0;
  private totalizerTriggerDrops = 0;
  private totalizerAddsSkipped = 0;
  private totalizerResetDrops = 0;

  constructor(
    private readonly store: FoldStateStore,
    private readonly sink: FoldCommitSink,
    private readonly logger: LivestoreLogger,
    private readonly now: () => number = Date.now,
  ) {}

  async start(
    properties: Iterable<PropertyRuntime>,
    getProperty: (id: string) => FoldInputProperty | null,
  ): Promise<void> {
    this.stopped = false;
    for (const property of properties) {
      await this.upsertProperty(property, getProperty);
    }
    const counts = this.counts();
    this.logger.info(
      { windowCount: counts.windowCount, totalizerCount: counts.totalizerCount },
      "livestore fold resolver started",
    );
  }

  async upsertProperty(
    property: PropertyRuntime,
    getProperty: (id: string) => FoldInputProperty | null,
  ): Promise<void> {
    await this.removeProperty(property.id);

    let rt: FoldRuntime;
    if (isWindowResolverConfig(property.resolver)) {
      const errors = validateWindowResolver(property.resolver, getProperty);
      if (errors.length > 0) {
        this.logger.warn({ propertyId: property.id, errors }, "livestore window skipped: invalid resolver");
        return;
      }
      rt = await this.rehydrateWindow(property.id, property.resolver);
    } else if (isTotalizerResolverConfig(property.resolver)) {
      const errors = validateTotalizerResolver(property.resolver, getProperty);
      if (errors.length > 0) {
        this.logger.warn({ propertyId: property.id, errors }, "livestore totalizer skipped: invalid resolver");
        return;
      }
      rt = await this.rehydrateTotalizer(property.id, property.resolver, getProperty);
    } else {
      return;
    }

    this.byId.set(property.id, rt);
    const inputIds = new Set([rt.sourcePropertyId]);
    if (rt.kind === "totalizer") {
      inputIds.add(rt.triggerPropertyId);
      if (rt.resetPropertyId) inputIds.add(rt.resetPropertyId);
    }
    for (const inputId of inputIds) {
      const siblings = this.bySource.get(inputId) ?? [];
      siblings.push(rt);
      this.bySource.set(inputId, siblings);
    }
  }

  async removeProperty(propertyId: string): Promise<void> {
    const rt = this.byId.get(propertyId);
    if (!rt) return;
    this.byId.delete(propertyId);

    for (const [sourcePropertyId, runtimes] of this.bySource) {
      const next = runtimes.filter((runtime) => runtime.propertyId !== propertyId);
      if (next.length > 0) this.bySource.set(sourcePropertyId, next);
      else this.bySource.delete(sourcePropertyId);
    }

    if (rt.kind === "tumbling" && rt.closeTimer) clearTimeout(rt.closeTimer);
    if (rt.persistTimer) clearTimeout(rt.persistTimer);
    rt.persistTimer = null;
    await rt.emitChain;
    await this.store.put(rt.propertyId, this.stateForPersist(rt));
  }

  // Synchronous by design
  onInput(sourcePropertyId: string, input: ValueEnvelope): void {
    if (this.stopped) return;
    const runtimes = this.bySource.get(sourcePropertyId);
    if (!runtimes) return;

    for (const rt of runtimes) {
      if (rt.kind === "ewma") {
        const next = foldEwmaSample(rt.state, input, rt.alpha);
        if (next === rt.state) continue; // unusable sample dropped
        rt.state = next;
        this.emit(rt, buildEwmaEnvelope(next)); // EWMA emits on every input
        this.schedulePersist(rt);
        continue;
      }

      if (rt.kind === "totalizer") {
        this.onTotalizerInput(rt, sourcePropertyId, input);
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

  // One commit can play several roles when inputs share a property. Reset
  // applies first (the boundary starts the new period, then the same commit's
  // add counts toward it); source folds before trigger so an on-change add
  // uses the incoming value, not the previous one.
  private onTotalizerInput(rt: TotalizerRuntime, inputPropertyId: string, input: ValueEnvelope): void {
    if (rt.reset && inputPropertyId === rt.resetPropertyId) {
      this.onTotalizerReset(rt, rt.reset, input);
    }
    if (inputPropertyId === rt.sourcePropertyId) {
      rt.state = foldTotalizerSource(rt.state, input);
      this.schedulePersist(rt);
    }
    if (inputPropertyId !== rt.triggerPropertyId) return;

    // Replay/out-of-order guard: a trigger sample at or before the last folded
    // one must not re-fire (a re-delivered edge would double-add).
    if (rt.state.lastTriggerTs > 0 && input.timestamp <= rt.state.lastTriggerTs) {
      this.totalizerTriggerDrops += 1;
      if (rt.staleWarnTriggerTs !== rt.state.lastTriggerTs) {
        rt.staleWarnTriggerTs = rt.state.lastTriggerTs;
        this.logger.warn(
          { propertyId: rt.propertyId, inputTs: input.timestamp, lastTriggerTs: rt.state.lastTriggerTs },
          "livestore totalizer dropping stale trigger samples",
        );
      }
      return;
    }

    const result = foldTotalizerTrigger(rt.state, input, rt.trigger);
    rt.state = result.state;
    if (result.added) {
      this.emit(rt, buildTotalizerEnvelope(rt.state, input.timestamp));
      this.persistNow(rt); // adds are the business-critical mutation
      return;
    }
    if (result.skipped) {
      this.totalizerAddsSkipped += 1;
      this.logger.warn(
        { propertyId: rt.propertyId, triggerTs: input.timestamp },
        "livestore totalizer trigger fired with no usable source value",
      );
    }
    this.schedulePersist(rt);
  }

  private onTotalizerReset(rt: TotalizerRuntime, reset: GraphHookCondition, input: ValueEnvelope): void {
    // Same replay/out-of-order guard as the trigger: a re-delivered old shift
    // value would look like a change against the baseline and spuriously reset.
    if (rt.state.lastResetTs > 0 && input.timestamp <= rt.state.lastResetTs) {
      this.totalizerResetDrops += 1;
      if (rt.staleWarnResetTs !== rt.state.lastResetTs) {
        rt.staleWarnResetTs = rt.state.lastResetTs;
        this.logger.warn(
          { propertyId: rt.propertyId, inputTs: input.timestamp, lastResetTs: rt.state.lastResetTs },
          "livestore totalizer dropping stale reset samples",
        );
      }
      return;
    }
    const result = foldTotalizerReset(rt.state, input, reset);
    rt.state = result.state;
    if (result.reset) {
      this.emit(rt, buildTotalizerEnvelope(rt.state, input.timestamp));
      this.persistNow(rt); // resets are as business-critical as adds
      return;
    }
    this.schedulePersist(rt);
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
    const results = await Promise.allSettled(
      runtimes.map((rt) => this.store.put(rt.propertyId, this.stateForPersist(rt))),
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) this.logger.error({ failed }, "livestore fold state flush failed on shutdown");
    this.byId.clear();
    this.bySource.clear();
  }

  counts(): {
    windowCount: number;
    totalizerCount: number;
    lateSamplesDropped: number;
    gapBucketsSkipped: number;
    totalizerTriggerDrops: number;
    totalizerAddsSkipped: number;
    totalizerResetDrops: number;
  } {
    let totalizerCount = 0;
    for (const rt of this.byId.values()) {
      if (rt.kind === "totalizer") totalizerCount += 1;
    }
    return {
      windowCount: this.byId.size - totalizerCount,
      totalizerCount,
      lateSamplesDropped: this.lateSamplesDropped,
      gapBucketsSkipped: this.gapBucketsSkipped,
      totalizerTriggerDrops: this.totalizerTriggerDrops,
      totalizerAddsSkipped: this.totalizerAddsSkipped,
      totalizerResetDrops: this.totalizerResetDrops,
    };
  }

  // Restart loads persisted state into agg state
  private async rehydrateWindow(propertyId: string, config: WindowResolverConfig): Promise<FoldRuntime> {
    const loaded = await this.store.get(propertyId);
    // State folded from a different source property must not seed this window.
    // (Pre-existing state without the field is trusted as-is.)
    const sourceMatches = loaded?.sourcePropertyId === undefined || loaded.sourcePropertyId === config.sourcePropertyId;
    if (loaded && !sourceMatches) {
      this.logger.warn({ propertyId }, "livestore window state discarded (source property changed)");
    }
    const persisted = loaded && sourceMatches ? loaded : null;

    if (config.kind === "ewma") {
      const state = persisted?.kind === "ewma" ? persisted : initEwmaState();
      const rt: EwmaRuntime = {
        kind: "ewma",
        propertyId,
        sourcePropertyId: config.sourcePropertyId,
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
      sourcePropertyId: config.sourcePropertyId,
      windowMs,
      alignToMs,
      aggregation: config.aggregation as Aggregation,
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

  // The running total survives restarts AND input rewires — it's the business
  // quantity; only the per-input tracking fields reset when an input changes.
  private async rehydrateTotalizer(
    propertyId: string,
    config: TotalizerResolverConfig,
    getProperty: (id: string) => FoldInputProperty | null,
  ): Promise<TotalizerRuntime> {
    const loaded = await this.store.get(propertyId);
    const trigger = parseGraphHookCondition(config.trigger);
    if (!trigger) throw new Error("totalizer trigger invalid after validation"); // unreachable
    const triggerPropertyId = trigger.source.propertyId;
    const reset = config.reset !== undefined ? parseGraphHookCondition(config.reset) : null;
    if (config.reset !== undefined && !reset) throw new Error("totalizer reset invalid after validation"); // unreachable
    const resetPropertyId = reset ? reset.source.propertyId : null;

    let state: TotalizerState;
    if (loaded?.kind === "totalizer") {
      state = loaded;
      if (state.sourcePropertyId !== undefined && state.sourcePropertyId !== config.sourcePropertyId) {
        this.logger.warn({ propertyId }, "livestore totalizer source changed — resetting tracked source value");
        state = { ...state, latestSourceValue: null, latestSourceQuality: "good" };
      }
      if (state.triggerPropertyId !== undefined && state.triggerPropertyId !== triggerPropertyId) {
        this.logger.warn({ propertyId }, "livestore totalizer trigger changed — resetting trigger baseline");
        state = { ...state, lastTriggerValue: null, lastTriggerTs: 0 };
      }
      if (state.resetPropertyId !== undefined && state.resetPropertyId !== (resetPropertyId ?? undefined)) {
        this.logger.warn({ propertyId }, "livestore totalizer reset input changed — resetting reset baseline");
        state = { ...state, lastResetValue: null, lastResetTs: 0 };
      }
    } else {
      if (loaded) this.logger.warn({ propertyId }, "livestore totalizer state discarded (kind changed)");
      state = initTotalizerState();
    }

    // Seed the tracked source from its current value: a source that never
    // changes after the totalizer is created (or rewired) would otherwise
    // leave every trigger firing with nothing to add.
    if (state.latestSourceValue === null) {
      const current = getProperty(config.sourcePropertyId)?.current;
      if (current) state = foldTotalizerSource(state, current);
    }

    const rt: TotalizerRuntime = {
      kind: "totalizer",
      propertyId,
      sourcePropertyId: config.sourcePropertyId,
      trigger,
      triggerPropertyId,
      reset,
      resetPropertyId,
      state,
      staleWarnTriggerTs: -1,
      staleWarnResetTs: -1,
      persistTimer: null,
      emitChain: Promise.resolve(),
    };
    // Surface the running total immediately; a fresh totalizer reads 0.
    // Stamp the last emit's ts so the boot emit dedupes against CVG instead of
    // committing a spurious change; legacy state without the field falls back
    // to the newest tracked input ts (best effort, one boot).
    const lastEventTs = state.lastEmitTs > 0 ? state.lastEmitTs : Math.max(state.lastTriggerTs, state.lastResetTs);
    this.emit(rt, buildTotalizerEnvelope(state, lastEventTs > 0 ? lastEventTs : this.now()));
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

  // Commits for one runtime serialize on its chain; failures are contained there.
  private emit(rt: FoldRuntime, envelope: ValueEnvelope): void {
    const source = rt.kind === "totalizer" ? "totalizer" : "window";
    rt.emitChain = rt.emitChain
      .then(() => this.sink.commitValue(rt.propertyId, envelope, source))
      .catch((err) => this.logger.error({ err, propertyId: rt.propertyId }, `livestore ${source} emit failed`));
  }

  // Debounced persistence (§17.7): memory is authoritative; KV sees at most one write
  // per runtime per 500ms. The timer reads rt.state at fire time — always the latest fold.
  private schedulePersist(rt: FoldRuntime): void {
    if (this.stopped || rt.persistTimer) return;
    rt.persistTimer = setTimeout(() => {
      rt.persistTimer = null;
      this.persistNow(rt);
    }, PERSIST_DEBOUNCE_MS);
  }

  private persistNow(rt: FoldRuntime): void {
    if (rt.persistTimer) {
      clearTimeout(rt.persistTimer);
      rt.persistTimer = null;
    }
    void this.store
      .put(rt.propertyId, this.stateForPersist(rt))
      .catch((err) => this.logger.error({ err, propertyId: rt.propertyId }, "livestore fold state persist failed"));
  }

  // Stamp the inputs at persist time (folds create states without them), so a
  // future rehydrate can tell whether the state belongs to these inputs.
  private stateForPersist(rt: FoldRuntime): AggState {
    if (rt.kind === "totalizer") {
      return {
        ...rt.state,
        sourcePropertyId: rt.sourcePropertyId,
        triggerPropertyId: rt.triggerPropertyId,
        resetPropertyId: rt.resetPropertyId ?? undefined,
      };
    }
    return { ...rt.state, sourcePropertyId: rt.sourcePropertyId };
  }
}

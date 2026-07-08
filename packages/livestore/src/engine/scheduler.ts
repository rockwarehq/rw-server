import type { LivestoreLogger } from "../types/index.js";

// Generic reactive scheduler
// graph's recalc engine. A value
// change marks its dependents dirty; a short coalescing window collapses bursts
// into one flush; the flush evaluates the dirty set in topological order so each
// property recomputes once.
export class Scheduler {
  private readonly dirty = new Set<string>();
  private flushScheduled = false;
  private flushing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Consecutive flush-ends each id has survived in the dirty set. An id that
  // never settles (cycle, quarantined, or deleted property) gets dropped alone
  // instead of nuking the whole dirty set with it.
  private readonly stallCounts = new Map<string, number>();
  private flushCount = 0;
  private lastFlushAt: number | null = null;
  private flushMaxMs = 0;
  private evaluateFailures = 0;
  private static readonly DELAY_MS = 50;
  private static readonly MAX_DIRTY_PASSES = 25;

  constructor(
    private readonly getDependents: (propertyId: string) => string[],
    private readonly topoOrder: () => string[],
    private readonly evaluate: (propertyId: string) => Promise<void>,
    private readonly isBarrier: (propertyId: string) => boolean,
    private readonly logger: LivestoreLogger,
    private readonly afterSettled?: () => Promise<void>,
  ) {}

  // A property's value changed: walk its transitive dependents into the dirty set
  markDirty(changedPropertyId: string): void {
    this.enqueueDependents(changedPropertyId);
    this.schedule();
  }

  scheduleTerminal(): void {
    this.schedule(true);
  }

  markDirtyMany(propertyIds: Iterable<string>): void {
    for (const id of propertyIds) {
      if (this.dirty.has(id)) continue;
      this.dirty.add(id);
      this.enqueueDependents(id);
    }
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // flushMaxMs is a windowed max: reading it resets the window (worst flush since
  // the last read). dirtySetSize is the live recompute backlog.
  flushStats(): {
    flushCount: number;
    lastFlushAt: number | null;
    flushMaxMs: number;
    dirtySetSize: number;
    evaluateFailures: number;
  } {
    const flushMaxMs = this.flushMaxMs;
    this.flushMaxMs = 0;
    return {
      flushCount: this.flushCount,
      lastFlushAt: this.lastFlushAt,
      flushMaxMs,
      dirtySetSize: this.dirty.size,
      evaluateFailures: this.evaluateFailures,
    };
  }

  private enqueueDependents(propertyId: string): void {
    const stack = [...this.getDependents(propertyId)];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || this.dirty.has(id) || this.isBarrier(id)) continue;
      this.dirty.add(id);
      for (const dependent of this.getDependents(id)) stack.push(dependent);
    }
  }

  private schedule(force = false): void {
    if (this.flushScheduled || this.flushing || (!force && this.dirty.size === 0)) return;
    this.flushScheduled = true;
    this.timer = setTimeout(() => {
      this.flushScheduled = false;
      void this.flush();
    }, Scheduler.DELAY_MS);
  }

  // Must never reject: it runs under `void this.flush()`, so a rejection here is
  // an unhandled rejection that kills the process (lifecycle.ts escalates it).
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    const startedAt = Date.now();
    let evaluated = 0;
    try {
      for (const id of this.topoOrder()) {
        if (!this.dirty.has(id)) continue;
        this.dirty.delete(id);
        try {
          await this.evaluate(id);
        } catch (err) {
          // Skip the property this pass; the next input re-marks it. Retrying
          // here would spin hot against whatever made it fail.
          this.evaluateFailures += 1;
          this.logger.error({ err, propertyId: id }, "livestore evaluate failed — property skipped this flush");
        }
        evaluated += 1;
      }
    } finally {
      this.flushing = false;
      this.lastFlushAt = Date.now();
      this.flushCount += 1;
      const durationMs = this.lastFlushAt - startedAt;
      if (durationMs > this.flushMaxMs) this.flushMaxMs = durationMs;
    }
    this.logger.info({ evaluated }, "livestore flush complete");
    if (this.dirty.size === 0) {
      this.stallCounts.clear();
      await this.runAfterSettled();
      return;
    }

    // Per-id stall accounting: ids that settle reset; ids that survive
    // MAX_DIRTY_PASSES consecutive flush-ends are dropped individually, so a
    // busy-but-progressing dirty set never discards unrelated pending work.
    for (const [id] of this.stallCounts) {
      if (!this.dirty.has(id)) this.stallCounts.delete(id);
    }
    const stalled: string[] = [];
    for (const id of this.dirty) {
      const count = (this.stallCounts.get(id) ?? 0) + 1;
      this.stallCounts.set(id, count);
      if (count >= Scheduler.MAX_DIRTY_PASSES) stalled.push(id);
    }
    if (stalled.length > 0) {
      this.logger.warn(
        { count: stalled.length, propertyIds: stalled.slice(0, 20) },
        "livestore flush stalled (cycle?) — dropping stalled properties from dirty set",
      );
      for (const id of stalled) {
        this.dirty.delete(id);
        this.stallCounts.delete(id);
      }
    }

    if (this.dirty.size === 0) {
      await this.runAfterSettled();
      return;
    }
    this.schedule();
  }

  private async runAfterSettled(): Promise<void> {
    try {
      await this.afterSettled?.();
    } catch (err) {
      this.logger.error({ err }, "livestore after-settle hook failed");
    }
  }
}

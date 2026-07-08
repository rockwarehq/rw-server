import type { LivestoreLogger } from "./types.js";

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
  private dirtyPasses = 0;
  private flushCount = 0;
  private lastFlushAt: number | null = null;
  private flushMaxMs = 0;
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
  flushStats(): { flushCount: number; lastFlushAt: number | null; flushMaxMs: number; dirtySetSize: number } {
    const flushMaxMs = this.flushMaxMs;
    this.flushMaxMs = 0;
    return { flushCount: this.flushCount, lastFlushAt: this.lastFlushAt, flushMaxMs, dirtySetSize: this.dirty.size };
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

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    const startedAt = Date.now();
    let evaluated = 0;
    try {
      for (const id of this.topoOrder()) {
        if (!this.dirty.has(id)) continue;
        this.dirty.delete(id);
        await this.evaluate(id);
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
      this.dirtyPasses = 0;
      await this.afterSettled?.();
      return;
    }

    this.dirtyPasses += 1;
    if (this.dirtyPasses >= Scheduler.MAX_DIRTY_PASSES) {
      this.logger.warn({ remaining: this.dirty.size }, "livestore flush stalled (cycle?) — dropping dirty set");
      this.dirty.clear();
      this.dirtyPasses = 0;
      await this.afterSettled?.();
      return;
    }
    this.schedule();
  }
}

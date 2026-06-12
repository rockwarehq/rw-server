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
  private static readonly DELAY_MS = 50;
  private static readonly MAX_DIRTY_PASSES = 25;

  constructor(
    private readonly getDependents: (propertyId: string) => string[],
    private readonly topoOrder: () => string[],
    private readonly evaluate: (propertyId: string) => Promise<void>,
    private readonly isBarrier: (propertyId: string) => boolean,
    private readonly logger: LivestoreLogger,
  ) {}

  // A property's value changed: walk its transitive dependents into the dirty set
  markDirty(changedPropertyId: string): void {
    this.enqueueDependents(changedPropertyId);
    this.schedule();
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

  private enqueueDependents(propertyId: string): void {
    const stack = [...this.getDependents(propertyId)];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || this.dirty.has(id) || this.isBarrier(id)) continue;
      this.dirty.add(id);
      for (const dependent of this.getDependents(id)) stack.push(dependent);
    }
  }

  private schedule(): void {
    if (this.flushScheduled || this.flushing || this.dirty.size === 0) return;
    this.flushScheduled = true;
    this.timer = setTimeout(() => {
      this.flushScheduled = false;
      void this.flush();
    }, Scheduler.DELAY_MS);
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
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
    }
    this.logger.info({ evaluated }, "livestore flush complete");
    if (this.dirty.size === 0) {
      this.dirtyPasses = 0;
      return;
    }

    this.dirtyPasses += 1;
    if (this.dirtyPasses >= Scheduler.MAX_DIRTY_PASSES) {
      this.logger.warn({ remaining: this.dirty.size }, "livestore flush stalled (cycle?) — dropping dirty set");
      this.dirty.clear();
      this.dirtyPasses = 0;
      return;
    }
    this.schedule();
  }
}

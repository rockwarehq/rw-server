import type { LivestoreLogger } from "./types.js";

// Generic reactive scheduler (spec §8.4/§8.5): the graph's recalc engine. A value
// change marks its dependents dirty; a short coalescing window collapses bursts
// into one flush; the flush evaluates the dirty set in topological order so each
// property recomputes once, after its inputs. Not rollup-specific — expr/window
// dispatch through the same evaluate() callback.
export class Scheduler {
  private readonly dirty = new Set<string>();
  private flushScheduled = false;
  private flushing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DELAY_MS = 50;

  constructor(
    private readonly getDependents: (propertyId: string) => string[],
    private readonly topoOrder: () => string[],
    private readonly evaluate: (propertyId: string) => Promise<void>,
    private readonly logger: LivestoreLogger,
  ) {}

  // A property's value changed: walk its transitive dependents into the dirty set
  // (the property itself already holds its new value), then schedule one flush.
  markDirty(changedPropertyId: string): void {
    this.enqueueDependents(changedPropertyId);
    this.schedule();
  }

  // Force (re)evaluation of the given properties themselves plus their dependents.
  // Used at boot to compute rollups once their children are seeded (§18.7).
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
      if (id === undefined || this.dirty.has(id)) continue;
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

  // Evaluate the dirty set in topological order (inputs before outputs). Recompute
  // commits re-enter via the evaluate callback and dirty their own dependents —
  // caught in this same pass since they sort later.
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
    if (this.dirty.size > 0) {
      // Left dirty after a full topo pass implies a cycle; drop to avoid a spin.
      this.logger.warn({ remaining: this.dirty.size }, "livestore flush left dirty nodes (cycle?)");
      this.dirty.clear();
    }
  }
}

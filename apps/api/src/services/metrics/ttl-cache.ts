// ── Generic process-level TTL cache ──────────────────────────────
// A simple in-memory Map with per-entry TTL and an LRU eviction cap.
//
// Used by shift.ts and hierarchy.ts to share lookup results across
// pipeline executions. Entries expire after `ttlMs` milliseconds and
// the cache never grows beyond `maxSize` entries (oldest-access is
// evicted when full).
//
// Thread-safe for single-threaded Node.js event loop — no locking.
// Not suitable for multi-process deployments without external
// synchronization (not needed here: each process maintains its own
// hot cache and falls back to DB on miss).

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly map = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(opts: { ttlMs: number; maxSize: number }) {
    this.ttlMs = opts.ttlMs;
    this.maxSize = opts.maxSize;
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }

    // Move to end (most recently used) — Map preserves insertion order
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Delete first so re-set moves to end
    this.map.delete(key);

    // Evict oldest entries if at capacity
    while (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }

    this.map.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** Remove all entries. */
  clear(): void {
    this.map.clear();
  }

  /** Current number of entries (including expired but not yet evicted). */
  get size(): number {
    return this.map.size;
  }
}

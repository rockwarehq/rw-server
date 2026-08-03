// Runs tasks keyed by an arbitrary string: tasks sharing a key execute
// strictly in submission order; tasks with different keys run concurrently,
// capped by a global semaphore. Used by the imm-events dispatcher to record
// cycles for many stations in parallel without reordering any one station.

export class KeyedSerialExecutor {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`concurrency must be a positive integer, got ${concurrency}`);
    }
  }

  /** Lanes with queued or running work. */
  get laneCount(): number {
    return this.tails.size;
  }

  /** Tasks currently executing (holding a semaphore slot). */
  get activeCount(): number {
    return this.active;
  }

  /** Resolves when the task settles. Never rejects — a task rejection would
   *  sever its lane's chain, so errors are logged and swallowed here; tasks
   *  that care must handle their own failures. */
  submit(key: string, task: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const tail = prev.then(() => this.run(task));
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return tail;
  }

  /** Resolves when everything submitted so far has settled. */
  async drain(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all([...this.tails.values()]);
    }
  }

  private async run(task: () => Promise<void>): Promise<void> {
    await this.acquire();
    try {
      await task();
    } catch (err) {
      console.error("[keyed-serial-executor] task threw:", err);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}

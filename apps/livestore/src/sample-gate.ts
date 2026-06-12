// Per-property evaluation throttle 
// This is used to prevent expensive computations from running too frequently when their dependencies are rapidly changing.
export class SampleGate {
  private readonly lastEvaluatedAt = new Map<string, number>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly remark: (propertyId: string) => void) {}

  shouldDefer(propertyId: string, sampleRateMs: number | null): boolean {
    if (!sampleRateMs) return false;
    const last = this.lastEvaluatedAt.get(propertyId);
    if (last === undefined) return false;
    const sinceLast = Date.now() - last;
    if (sinceLast >= sampleRateMs) return false;
    if (!this.pending.has(propertyId)) {
      const timer = setTimeout(() => {
        this.pending.delete(propertyId);
        this.remark(propertyId);
      }, sampleRateMs - sinceLast);
      this.pending.set(propertyId, timer);
    }
    return true;
  }

  recordEvaluated(propertyId: string): void {
    this.lastEvaluatedAt.set(propertyId, Date.now());
  }

  stop(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}

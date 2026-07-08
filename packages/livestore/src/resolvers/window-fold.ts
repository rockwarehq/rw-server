import { usableValue, type EwmaState, type TumblingState, type ValueEnvelope } from "../value/types.js";

// Bucket boundary a timestamp falls in, floored to the windowMs grid anchored at alignToMs.
export function bucketStartFor(timestamp: number, windowMs: number, alignToMs = 0): number {
  return alignToMs + Math.floor((timestamp - alignToMs) / windowMs) * windowMs;
}

export function initTumblingState(bucketStart: number, windowMs: number): TumblingState {
  return {
    kind: "tumbling",
    bucketStart,
    bucketEnd: bucketStart + windowMs,
    count: 0,
    sum: 0,
    min: null,
    max: null,
    goodCount: 0,
    totalCount: 0,
  };
}

// Fold one sample into the open bucket.
export function foldTumblingSample(state: TumblingState, input: ValueEnvelope): TumblingState {
  const next: TumblingState = { ...state, totalCount: state.totalCount + 1 };
  const v = usableValue(input);
  if (v === null) return next;
  next.count += 1;
  next.sum += v;
  next.min = next.min === null ? v : Math.min(next.min, v);
  next.max = next.max === null ? v : Math.max(next.max, v);
  if (input.quality === "good") next.goodCount += 1;
  return next;
}

// lastInputTs === 0 marks an unseeded EWMA: the first usable sample seeds value directly.
export function initEwmaState(): EwmaState {
  return { kind: "ewma", value: 0, lastInputTs: 0, lastInputQuality: "good" };
}

// Unusable samples are dropped entirely (same state back) — EWMA has no gap counter.
export function foldEwmaSample(state: EwmaState, input: ValueEnvelope, alpha: number): EwmaState {
  const v = usableValue(input);
  if (v === null) return state;
  const value = state.lastInputTs === 0 ? v : alpha * v + (1 - alpha) * state.value;
  return { kind: "ewma", value, lastInputTs: input.timestamp, lastInputQuality: input.quality };
}

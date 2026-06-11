import type { Aggregation, EwmaState, Quality, TumblingState, ValueEnvelope } from "./types.js";

// Value of a closed tumbling bucket per aggregation
export function aggregateTumbling(state: TumblingState, aggregation: Aggregation): number | null {
  switch (aggregation) {
    case "sum":
      return state.sum;
    case "count":
      return state.count;
    case "avg":
      return state.count > 0 ? state.sum / state.count : null;
    case "min":
      return state.min;
    case "max":
      return state.max;
    default:
      return null;
  }
}

export function tumblingQuality(state: TumblingState): Quality {
  if (state.count === 0) return "bad";
  if (state.goodCount / state.totalCount < 0.5) return "uncertain";
  return "good";
}

// Built on bucket close;
export function buildTumblingEnvelope(
  state: TumblingState,
  aggregation: Aggregation,
  timestamp: number,
): ValueEnvelope {
  return {
    value: aggregateTumbling(state, aggregation),
    quality: tumblingQuality(state),
    timestamp,
    context: { count: state.count, windowStart: state.bucketStart, windowEnd: state.bucketEnd },
  };
}

// Built on every input; input quality propagates directly (event-driven).
export function buildEwmaEnvelope(state: EwmaState): ValueEnvelope {
  return {
    value: state.value,
    quality: state.lastInputQuality,
    timestamp: state.lastInputTs,
  };
}

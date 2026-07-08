import type { GraphHookCondition } from "../catalog/hook-conditions.js";

import type { ValueEnvelope } from "../value/types.js";

const EDGE_OPERATORS = new Set(["changed", "increases", "decreases", "crossesAbove", "crossesBelow"]);

export function evaluateHookCondition(
  condition: GraphHookCondition,
  previous: ValueEnvelope,
  current: ValueEnvelope,
): boolean {
  if (current.quality !== "good") return false;
  if (EDGE_OPERATORS.has(condition.operator) && previous.quality !== "good") return false;

  switch (condition.operator) {
    case "changed":
      return !valuesEqual(previous.value, current.value);
    case "increases": {
      const prev = asFiniteNumber(previous.value);
      const next = asFiniteNumber(current.value);
      if (prev === null || next === null) return false;
      const delta = next - prev;
      return delta > 0 && delta >= (condition.minDelta ?? 0);
    }
    case "decreases": {
      const prev = asFiniteNumber(previous.value);
      const next = asFiniteNumber(current.value);
      if (prev === null || next === null) return false;
      const delta = prev - next;
      return delta > 0 && delta >= (condition.minDelta ?? 0);
    }
    case "equals":
      return valuesEqual(current.value, condition.value);
    case "notEquals":
      return !valuesEqual(current.value, condition.value);
    case "gt":
      return (
        condition.threshold !== undefined &&
        compareCurrent(current.value, condition.threshold, (value, threshold) => value > threshold)
      );
    case "gte":
      return (
        condition.threshold !== undefined &&
        compareCurrent(current.value, condition.threshold, (value, threshold) => value >= threshold)
      );
    case "lt":
      return (
        condition.threshold !== undefined &&
        compareCurrent(current.value, condition.threshold, (value, threshold) => value < threshold)
      );
    case "lte":
      return (
        condition.threshold !== undefined &&
        compareCurrent(current.value, condition.threshold, (value, threshold) => value <= threshold)
      );
    case "crossesAbove": {
      if (condition.threshold === undefined) return false;
      const prev = asFiniteNumber(previous.value);
      const next = asFiniteNumber(current.value);
      return prev !== null && next !== null && prev <= condition.threshold && next > condition.threshold;
    }
    case "crossesBelow": {
      if (condition.threshold === undefined) return false;
      const prev = asFiniteNumber(previous.value);
      const next = asFiniteNumber(current.value);
      return prev !== null && next !== null && prev >= condition.threshold && next < condition.threshold;
    }
  }
}

function compareCurrent(
  rawValue: unknown,
  threshold: number,
  compare: (value: number, threshold: number) => boolean,
): boolean {
  const value = asFiniteNumber(rawValue);
  return value !== null && compare(value, threshold);
}

function asFiniteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

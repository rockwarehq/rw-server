import { parseGraphHookCondition, type GraphHookCondition } from "../catalog/hook-conditions.js";

import { evaluateHookCondition } from "./hook-condition.js";
import {
  isStatefulResolverType,
  usableValue,
  worse,
  type TotalizerResolverConfig,
  type TotalizerState,
  type ValueEnvelope,
} from "../types/index.js";

export function initTotalizerState(): TotalizerState {
  return {
    kind: "totalizer",
    total: 0,
    count: 0,
    lastQuality: "good",
    lastTriggerValue: null,
    lastTriggerTs: 0,
    lastResetValue: null,
    lastResetTs: 0,
    lastEmitTs: 0,
    latestSourceValue: null,
    latestSourceQuality: "good",
  };
}

// Track the newest usable source value; unusable samples are dropped.
export function foldTotalizerSource(state: TotalizerState, input: ValueEnvelope): TotalizerState {
  const v = usableValue(input);
  if (v === null) return state;
  return { ...state, latestSourceValue: v, latestSourceQuality: input.quality };
}

export type TotalizerTriggerResult = {
  state: TotalizerState;
  added: boolean;
  // Trigger fired but no usable source value existed to add.
  skipped: boolean;
};

// Evaluate the trigger against the last GOOD trigger sample (not the raw
// previous envelope), so a quality flap mid-high can't fake or mask an edge.
export function foldTotalizerTrigger(
  state: TotalizerState,
  input: ValueEnvelope,
  trigger: GraphHookCondition,
): TotalizerTriggerResult {
  const previous: ValueEnvelope = {
    value: state.lastTriggerValue,
    quality: state.lastTriggerTs > 0 ? "good" : "uncertain",
    timestamp: state.lastTriggerTs,
  };
  const fires = evaluateHookCondition(trigger, previous, input);
  const next =
    input.quality === "good" ? { ...state, lastTriggerValue: input.value, lastTriggerTs: input.timestamp } : state;
  if (!fires) return { state: next, added: false, skipped: false };
  if (next.latestSourceValue === null) return { state: next, added: false, skipped: true };
  return {
    state: {
      ...next,
      total: next.total + next.latestSourceValue,
      count: next.count + 1,
      lastQuality: worse(input.quality, next.latestSourceQuality),
      lastEmitTs: input.timestamp,
    },
    added: true,
    skipped: false,
  };
}

export type TotalizerResetResult = {
  state: TotalizerState;
  reset: boolean;
};

// Evaluate the reset against the last GOOD reset sample (same rule as the
// trigger); firing zeroes total+count. First sample is a baseline, so a
// restart never causes a spurious reset.
export function foldTotalizerReset(
  state: TotalizerState,
  input: ValueEnvelope,
  reset: GraphHookCondition,
): TotalizerResetResult {
  const previous: ValueEnvelope = {
    value: state.lastResetValue,
    quality: state.lastResetTs > 0 ? "good" : "uncertain",
    timestamp: state.lastResetTs,
  };
  const fires = evaluateHookCondition(reset, previous, input);
  const next =
    input.quality === "good" ? { ...state, lastResetValue: input.value, lastResetTs: input.timestamp } : state;
  if (!fires) return { state: next, reset: false };
  return {
    state: { ...next, total: 0, count: 0, lastQuality: input.quality, lastEmitTs: input.timestamp },
    reset: true,
  };
}

// Built on every add (and on rehydrate); a fresh totalizer legitimately reads 0.
export function buildTotalizerEnvelope(state: TotalizerState, timestamp: number): ValueEnvelope {
  return {
    value: state.total,
    quality: state.lastQuality,
    timestamp,
    context: { count: state.count },
  };
}

// Save/load-time validation of the config for resolver type totalizer.
export function validateTotalizerResolver(
  config: TotalizerResolverConfig,
  getProperty: (id: string) => { resolverType: string } | null,
): string[] {
  const errors: string[] = [];

  const checkInput = (propertyId: string, role: string) => {
    const dep = getProperty(propertyId);
    if (!dep) {
      errors.push(`${role} property "${propertyId}" does not exist`);
    } else if (isStatefulResolverType(dep.resolverType)) {
      errors.push(`${role} property is a window or totalizer — chained stateful resolvers are not allowed (§17.10)`);
    }
  };

  checkInput(config.sourcePropertyId, "source");

  const checked = new Set([config.sourcePropertyId]);
  const trigger = parseGraphHookCondition(config.trigger);
  if (!trigger) {
    errors.push("totalizer trigger must be a valid hook condition");
  } else if (!checked.has(trigger.source.propertyId)) {
    checked.add(trigger.source.propertyId);
    checkInput(trigger.source.propertyId, "trigger");
  }

  if (config.reset !== undefined) {
    const reset = parseGraphHookCondition(config.reset);
    if (!reset) {
      errors.push("totalizer reset must be a valid hook condition");
    } else if (!checked.has(reset.source.propertyId)) {
      checkInput(reset.source.propertyId, "reset");
    }
  }

  return errors;
}

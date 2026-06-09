import { evaluate } from "mathjs";

import { worse, type Quality, type ValueEnvelope } from "./types.js";

// Property UUIDs contain hyphens, which mathjs parses as minus. Encode each
// reference as a valid symbol: p_<uuid with "-" -> "_">. Reversible (uuids have no
// underscores), and stable so the stored expression and the eval scope agree.
export function symbolFor(propertyId: string): string {
  return "p_" + propertyId.replaceAll("-", "_");
}

// Evaluate a mathjs expression over its dependency property values (spec §8.6).
// Inputs are referenced by symbolFor(depId). Quality is the worst of the inputs;
// any missing input or a non-finite result (e.g. divide-by-zero) yields a null
// value with reduced quality — matching the worker's NULL-on-zero-denominator.
export function evaluateExpr(expression: string, deps: { id: string; current: ValueEnvelope }[]): ValueEnvelope {
  const scope: Record<string, number> = {};
  let worstQuality: Quality = "good";
  let present = 0;
  let latestTs = 0;

  for (const dep of deps) {
    const v = Number(dep.current.value);
    if (dep.current.value == null || dep.current.quality === "bad" || !Number.isFinite(v)) {
      worstQuality = worse(worstQuality, "uncertain");
      continue;
    }
    present += 1;
    worstQuality = worse(worstQuality, dep.current.quality);
    if (dep.current.timestamp > latestTs) latestTs = dep.current.timestamp;
    scope[symbolFor(dep.id)] = v;
  }

  const timestamp = latestTs || Date.now();
  if (deps.length === 0 || present < deps.length) {
    return { value: null, quality: worse(worstQuality, "uncertain"), timestamp, context: { expr: true } };
  }

  let value: number | null = null;
  try {
    const result = evaluate(expression, scope);
    value = typeof result === "number" && Number.isFinite(result) ? result : null;
  } catch {
    value = null;
  }
  const quality = value == null ? worse(worstQuality, "uncertain") : worstQuality;
  return { value, quality, timestamp, context: { expr: true } };
}

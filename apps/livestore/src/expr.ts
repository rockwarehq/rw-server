import { evaluate } from "mathjs";

import { usableValue, worse, type Quality, type ValueEnvelope } from "./types.js";

export const MAX_EXPRESSION_LENGTH = 2000;

export function prefixPropertyId(propertyId: string): string {
  return "p_" + propertyId.replaceAll("-", "_");
}

type ScopeBuild = {
  scope: Record<string, number>;
  worstQuality: Quality;
  present: number;
  latestTs: number;
};

// map uuid to property value. stale value = uncertain 
function buildScope(deps: { id: string; current: ValueEnvelope }[]): ScopeBuild {
  const scope: Record<string, number> = {};
  let worstQuality: Quality = "good";
  let present = 0;
  let latestTs = 0;

  for (const dep of deps) {
    const v = usableValue(dep.current);
    if (v === null) {
      worstQuality = worse(worstQuality, "uncertain");
      continue;
    }
    present += 1;
    worstQuality = worse(worstQuality, dep.current.quality);
    if (dep.current.timestamp > latestTs) latestTs = dep.current.timestamp;
    scope[prefixPropertyId(dep.id)] = v;
  }

  return { scope, worstQuality, present, latestTs };
}

// Check the expression, eg. non-numeric divide-by-zero
function safeEvaluate(expression: string, scope: Record<string, number>): number | null {
  try {
    const result = evaluate(expression, scope);
    return typeof result === "number" && Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

// Eval mathjs expression by its dependency property values
export function evaluateExpr(expression: string, deps: { id: string; current: ValueEnvelope }[]): ValueEnvelope {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return {
      value: null,
      quality: "bad",
      timestamp: Date.now(),
      context: { expr: true, error: "expression too long" },
    };
  }

  const { scope, worstQuality, present, latestTs } = buildScope(deps);
  const timestamp = latestTs || Date.now();

  if (deps.length === 0 || present < deps.length) {
    return { value: null, quality: worse(worstQuality, "uncertain"), timestamp, context: { expr: true } };
  }

  const value = safeEvaluate(expression, scope);
  const quality = value == null ? worse(worstQuality, "uncertain") : worstQuality;
  return { value, quality, timestamp, context: { expr: true } };
}

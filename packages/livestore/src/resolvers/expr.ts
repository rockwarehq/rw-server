import type { EvalFunction } from "mathjs";

import { compileExpression, DEFAULT_EVAL_TIMEOUT_MS } from "./expr-sandbox.js";
import { usableValue, worse, type LivestoreLogger, type Quality, type ValueEnvelope } from "../types/index.js";

export interface ExprEvalOptions {
  logger?: LivestoreLogger;
  timeoutMs?: number; // per-property ceiling override
}

export function prefixPropertyId(propertyId: string): string {
  return `p_${propertyId.replaceAll("-", "_")}`;
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
function safeEvaluate(compiled: EvalFunction, scope: Record<string, number>): number | null {
  try {
    const result = compiled.evaluate(scope);
    return typeof result === "number" && Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

// Eval sandboxed mathjs expression
export function evaluateExpr(
  expression: string,
  deps: { id: string; current: ValueEnvelope }[],
  opts: ExprEvalOptions = {},
): ValueEnvelope {
  const { compiled, error } = compileExpression(expression);
  if (!compiled) {
    return { value: null, quality: "bad", timestamp: Date.now(), context: { expr: true, error } };
  }

  const { scope, worstQuality, present, latestTs } = buildScope(deps);
  const timestamp = latestTs || Date.now();

  if (deps.length === 0 || present < deps.length) {
    return { value: null, quality: worse(worstQuality, "uncertain"), timestamp, context: { expr: true } };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
  const start = performance.now();
  const value = safeEvaluate(compiled, scope);
  const elapsedMs = performance.now() - start;
  if (elapsedMs > timeoutMs) {
    opts.logger?.warn({ elapsedMs, expression: expression.slice(0, 120) }, "livestore expr eval exceeded timeout");
    return { value: null, quality: "bad", timestamp, context: { expr: true, error: "eval timeout" } };
  }

  const quality = value == null ? worse(worstQuality, "uncertain") : worstQuality;
  return { value, quality, timestamp, context: { expr: true } };
}

import { describe, expect, it } from "vitest";

import { compileExpression, MAX_AST_NODES, MAX_EXPRESSION_LENGTH, validateExpression } from "./expr-sandbox.js";

const VALID = [
  "p_a / p_b",
  "(p_idealCycleSeconds * p_goodItems) / (p_elapsedPlannedProductionSeconds * p_totalItems)",
  "min(p_a, 2) + max(p_b, 1)",
  "abs(-p_a) + round(p_a, 2) + floor(p_a) + ceil(p_a)",
  "sqrt(p_a) + exp(p_a) + log(p_a)",
  "p_a > p_b ? 1 : 0",
  "p_a >= 1 and p_b <= 2 ? 1 : 0",
  "round(pi, 2) + e",
  "-p_a + +p_b",
  "p_a mod 3",
  "p_a ^ 2",
];

const BLOCKED: [string, string][] = [
  ["import({})", "function"],
  ['createUnit("x")', "function"],
  ['evaluate("1+1")', "function"],
  ['parse("1+1")', "function"],
  ['simplify("x+x")', "function"],
  ["sin(1)", "function"],
  ["a = 2", "unsupported syntax"],
  ["f(x) = x", "unsupported syntax"],
  ["[1, 2, 3]", "unsupported syntax"],
  ["{a: 1}", "unsupported syntax"],
  ["1:10000", "unsupported syntax"],
  ["1 < p_a < 3", "unsupported syntax"],
  ["1!", "operator"],
  ['"abc"', "constant"],
  ["foo + 1", "symbol"],
];

describe("validateExpression", () => {
  it.each(VALID)("allows %s", (expr) => {
    expect(validateExpression(expr)).toEqual([]);
  });

  it.each(BLOCKED)("blocks %s", (expr, errorWord) => {
    const errors = validateExpression(expr);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("; ")).toContain(errorWord);
  });

  it("blocks constructor escape attempts", () => {
    expect(validateExpression('abs.constructor("return process")()').length).toBeGreaterThan(0);
    expect(validateExpression('cos.constructor("return process")()').length).toBeGreaterThan(0);
  });

  it("blocks oversized expressions", () => {
    expect(validateExpression(`${"1 + ".repeat(MAX_EXPRESSION_LENGTH / 4)}1`)[0]).toContain("characters");
  });

  it("blocks expressions over the node budget", () => {
    const expr = Array.from({ length: MAX_AST_NODES }, () => "1").join(" + ");
    expect(validateExpression(expr).join("; ")).toContain("nodes");
  });
});

describe("compileExpression", () => {
  it("compiles valid expressions and evaluates with scope", () => {
    const result = compileExpression("p_a / p_b");
    expect(result.error).toBeNull();
    expect(result.compiled?.evaluate({ p_a: 6, p_b: 2 })).toBe(3);
  });

  it("returns the error for invalid expressions", () => {
    const result = compileExpression("a = 2");
    expect(result.compiled).toBeNull();
    expect(result.error).toContain("unsupported syntax");
  });

  it("caches both successes and failures", () => {
    expect(compileExpression("p_a + 1")).toBe(compileExpression("p_a + 1"));
    expect(compileExpression("a = 2")).toBe(compileExpression("a = 2"));
  });
});

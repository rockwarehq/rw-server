import { describe, expect, it } from "vitest";

import { evaluateFormula, type FormulaNode, formulaFields } from "../formula.js";

const f = (key: string): FormulaNode => ({ kind: "field", key });
const c = (value: number): FormulaNode => ({ kind: "const", value });
const bin = (kind: "add" | "sub" | "mul" | "div", left: FormulaNode, right: FormulaNode): FormulaNode => ({
  kind,
  left,
  right,
});

describe("evaluateFormula", () => {
  it("evaluates constants", () => {
    expect(evaluateFormula(c(5), {})).toBe(5);
  });

  it("evaluates fields", () => {
    expect(evaluateFormula(f("x"), { x: 7 })).toBe(7);
  });

  it("throws on a missing field (programming error)", () => {
    expect(() => evaluateFormula(f("x"), { y: 1 })).toThrow('missing field "x"');
  });

  it("evaluates all four operators", () => {
    expect(evaluateFormula(bin("add", c(2), c(3)), {})).toBe(5);
    expect(evaluateFormula(bin("sub", c(2), c(3)), {})).toBe(-1);
    expect(evaluateFormula(bin("mul", c(2), c(3)), {})).toBe(6);
    expect(evaluateFormula(bin("div", c(6), c(3)), {})).toBe(2);
  });

  it("evaluates nested expressions", () => {
    // (a + b) * c / 2 = (2 + 3) * 4 / 2 = 10
    const node = bin("div", bin("mul", bin("add", f("a"), f("b")), f("c")), c(2));
    expect(evaluateFormula(node, { a: 2, b: 3, c: 4 })).toBe(10);
  });

  it("returns null on division by zero", () => {
    expect(evaluateFormula(bin("div", c(1), c(0)), {})).toBeNull();
    expect(evaluateFormula(bin("div", c(1), f("x")), { x: 0 })).toBeNull();
  });

  it("propagates null through parent nodes", () => {
    const node = bin("add", bin("div", c(1), c(0)), c(1));
    expect(evaluateFormula(node, {})).toBeNull();
  });
});

describe("formulaFields", () => {
  it("collects unique field keys in first-appearance order", () => {
    const node = bin("div", bin("mul", f("a"), bin("sub", f("b"), f("a"))), bin("mul", f("c"), c(2)));
    expect(formulaFields(node)).toEqual(["a", "b", "c"]);
  });

  it("returns empty for constant-only formulas", () => {
    expect(formulaFields(bin("add", c(1), c(2)))).toEqual([]);
  });
});

/**
 * Minimal arithmetic AST over named numeric fields.
 *
 * Kept deliberately tiny: catalog formulas must be renderable to SQL by
 * consumers AND evaluable in TS with matching semantics. Division by zero
 * yields null (SQL NULLIF-style), and null propagates upward — mirroring
 * how the MetricBucket generated columns behave.
 */

export type FormulaNode =
  | { kind: "field"; key: string }
  | { kind: "const"; value: number }
  | { kind: "add" | "sub" | "mul" | "div"; left: FormulaNode; right: FormulaNode };

/**
 * Evaluate a formula against a field map.
 *
 * Returns null on division by zero (propagated through parent nodes).
 * Throws on a field key absent from `fields` — that is a programming
 * error (catalog deps out of sync), not a data condition.
 */
export function evaluateFormula(node: FormulaNode, fields: Record<string, number>): number | null {
  switch (node.kind) {
    case "const":
      return node.value;
    case "field": {
      if (!(node.key in fields)) {
        throw new Error(`evaluateFormula: missing field "${node.key}"`);
      }
      return fields[node.key] as number;
    }
    default: {
      const left = evaluateFormula(node.left, fields);
      if (left === null) return null;
      const right = evaluateFormula(node.right, fields);
      if (right === null) return null;
      switch (node.kind) {
        case "add":
          return left + right;
        case "sub":
          return left - right;
        case "mul":
          return left * right;
        case "div":
          return right === 0 ? null : left / right;
      }
    }
  }
}

/** Unique field keys referenced by a formula, in first-appearance order. */
export function formulaFields(node: FormulaNode): string[] {
  const keys: string[] = [];
  const walk = (n: FormulaNode): void => {
    if (n.kind === "field") {
      if (!keys.includes(n.key)) keys.push(n.key);
    } else if (n.kind !== "const") {
      walk(n.left);
      walk(n.right);
    }
  };
  walk(node);
  return keys;
}

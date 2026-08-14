import type { FormulaNode } from "@rockwarehq/metrics";

// Renders a catalog formula AST to a canonical plain string for the
// capability manifest (and the parity tests that pin it): fields and
// constants bare, every nested binary expression parenthesized, single
// spaces around operators. e.g. "(totalItems - badItems) / totalItems".

const OPERATORS = { add: "+", sub: "-", mul: "*", div: "/" } as const;

export function formulaToString(node: FormulaNode): string {
  switch (node.kind) {
    case "field":
      return node.key;
    case "const":
      return String(node.value);
    default:
      return `${renderOperand(node.left)} ${OPERATORS[node.kind]} ${renderOperand(node.right)}`;
  }
}

function renderOperand(node: FormulaNode): string {
  const rendered = formulaToString(node);
  return node.kind === "field" || node.kind === "const" ? rendered : `(${rendered})`;
}

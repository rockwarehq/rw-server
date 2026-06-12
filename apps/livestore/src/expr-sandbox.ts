import {
  absDependencies,
  addDependencies,
  andDependencies,
  ceilDependencies,
  create,
  divideDependencies,
  eDependencies,
  equalDependencies,
  expDependencies,
  floorDependencies,
  largerDependencies,
  largerEqDependencies,
  logDependencies,
  maxDependencies,
  minDependencies,
  modDependencies,
  multiplyDependencies,
  notDependencies,
  orDependencies,
  parseDependencies,
  piDependencies,
  powDependencies,
  roundDependencies,
  smallerDependencies,
  smallerEqDependencies,
  sqrtDependencies,
  subtractDependencies,
  unaryMinusDependencies,
  unaryPlusDependencies,
  unequalDependencies,
} from "mathjs/number";
import type { ConstantNode, EvalFunction, FactoryFunctionMap, MathNode, OperatorNode, SymbolNode } from "mathjs";

export const MAX_EXPRESSION_LENGTH = 2000;
export const MAX_AST_NODES = 200;
export const DEFAULT_EVAL_TIMEOUT_MS = 100;

// Deny-by-default instance (§8.7): import/createUnit/evaluate don't exist here at all.
const math = create(
  {
    parseDependencies,
    addDependencies,
    subtractDependencies,
    multiplyDependencies,
    divideDependencies,
    powDependencies,
    modDependencies,
    unaryMinusDependencies,
    unaryPlusDependencies,
    equalDependencies,
    unequalDependencies,
    smallerDependencies,
    smallerEqDependencies,
    largerDependencies,
    largerEqDependencies,
    andDependencies,
    orDependencies,
    notDependencies,
    minDependencies,
    maxDependencies,
    absDependencies,
    roundDependencies,
    floorDependencies,
    ceilDependencies,
    sqrtDependencies,
    expDependencies,
    logDependencies,
    piDependencies,
    eDependencies,
    // mathjs types these exports as possibly undefined under noUncheckedIndexedAccess
  } as FactoryFunctionMap,
  { number: "number" },
);

const ALLOWED_FUNCTIONS = new Set(["min", "max", "abs", "round", "floor", "ceil", "sqrt", "exp", "log"]);
const ALLOWED_OPERATORS = new Set([
  "add",
  "subtract",
  "multiply",
  "divide",
  "pow",
  "mod",
  "unaryMinus",
  "unaryPlus",
  "equal",
  "unequal",
  "smaller",
  "smallerEq",
  "larger",
  "largerEq",
  "and",
  "or",
  "not",
]);
const ALLOWED_CONSTANTS = new Set(["pi", "e"]);
const VARIABLE_PATTERN = /^p_\w+$/; // prefixPropertyId shape

function checkNode(node: MathNode, path: string | null): string | null {
  switch (node.type) {
    case "ConstantNode":
      return typeof (node as ConstantNode).value === "number" ? null : "only numeric constants are allowed";
    case "SymbolNode": {
      const name = (node as SymbolNode).name;
      if (path === "fn") return ALLOWED_FUNCTIONS.has(name) ? null : `function "${name}" is not allowed`;
      if (ALLOWED_CONSTANTS.has(name) || VARIABLE_PATTERN.test(name)) return null;
      return `unknown symbol "${name}"`;
    }
    case "OperatorNode":
      return ALLOWED_OPERATORS.has((node as OperatorNode).fn as string)
        ? null
        : `operator "${(node as OperatorNode).op}" is not allowed`;
    case "ParenthesisNode":
    case "ConditionalNode":
    case "FunctionNode":
      return null;
    default:
      return `unsupported syntax "${node.type}"`;
  }
}

// Save/load-time validation : length, syntax, node budget, whitelist walk.
export function validateExpression(expression: string): string[] {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return [`expression exceeds ${MAX_EXPRESSION_LENGTH} characters`];
  }

  let root: MathNode;
  try {
    root = math.parse(expression);
  } catch (err) {
    return [`syntax error: ${err instanceof Error ? err.message : String(err)}`];
  }

  const errors = new Set<string>();
  let nodeCount = 0;
  root.traverse((node, path) => {
    nodeCount += 1;
    const error = checkNode(node, path);
    if (error) errors.add(error);
  });
  if (nodeCount > MAX_AST_NODES) errors.add(`expression exceeds ${MAX_AST_NODES} nodes`);
  return [...errors];
}

export type CompiledExpr = { compiled: EvalFunction; error: null } | { compiled: null; error: string };

// Compile-once cache (§8.6); failures cached too so bad stored expressions don't re-parse every tick.
const cache = new Map<string, CompiledExpr>();

export function compileExpression(expression: string): CompiledExpr {
  const hit = cache.get(expression);
  if (hit) return hit;

  const errors = validateExpression(expression);
  const entry: CompiledExpr = errors.length
    ? { compiled: null, error: errors.join("; ") }
    : { compiled: math.parse(expression).compile(), error: null };

  if (cache.size >= 500) cache.clear();
  cache.set(expression, entry);
  return entry;
}

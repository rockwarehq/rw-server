import {
  absDependencies,
  addDependencies,
  andDependencies,
  ceilDependencies,
  create,
  divideDependencies,
  equalDependencies,
  floorDependencies,
  largerDependencies,
  largerEqDependencies,
  maxDependencies,
  minDependencies,
  modDependencies,
  multiplyDependencies,
  notDependencies,
  orDependencies,
  parseDependencies,
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

/*
 * Formulas on a form: a computed field's value from the other answers. This
 * is the twin of rw-ui's apps/rw-imm/src/forms/formula.ts — the client shows
 * the result while someone fills the form, and submit works every formula out
 * again here and stores this result, so the two must agree. The shared cases
 * are formula.cases.json (a copy of the client's); change both together.
 *
 * The language is the LiveStore expression sandbox's (a deny-by-default
 * mathjs/number instance) with field keys as variables:
 *
 *   inspected - good            arithmetic: + - * / ^ mod, parentheses
 *   scrap / inspected > 0.05    comparisons, and / or / not
 *   passed ? 1 : 0              a ? b : c
 *   round(rate * 100, 1)        min max abs round floor ceil sqrt
 *
 * What a field means in a formula: a number or rating is its number, a
 * checkbox true or false (unticked = false), a checklist how many of its items
 * are ticked (none = 0), a computed field its own result, a scrap field whose
 * rows people enter the total quantity of its rows (none = 0). Text, dates,
 * choices, shift notes and a scrap field that takes its quantity from a
 * formula (it is an output) can't be used yet. A number nobody has entered leaves the result
 * blank (null) until it is.
 */

export const MAX_FORMULA_LENGTH = 500;
const MAX_NODES = 200;

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
  } as FactoryFunctionMap,
  { number: "number" },
);

export const FORMULA_FUNCTIONS = ["min", "max", "abs", "round", "floor", "ceil", "sqrt"] as const;
const FUNCTIONS = new Set<string>(FORMULA_FUNCTIONS);
const OPERATORS = new Set([
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

/** The field kinds a formula can read. */
export const FORMULA_INPUT_TYPES: ReadonlySet<string> = new Set([
  "number",
  "rating",
  "checkbox",
  "checklist",
  "computed",
  "scrap",
]);

/** A field's name in formulas: lowercase, starts with a letter, at most 40 long. */
export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  ...FORMULA_FUNCTIONS,
  "pi",
  "e",
  "true",
  "false",
  "mod",
  "and",
  "or",
  "not",
  "xor",
  "to",
  "in",
]);

export function isUsableKey(key: string): boolean {
  return KEY_PATTERN.test(key) && !RESERVED_KEYS.has(key);
}

/** What formulas need of a manifest field; manifest.ts's FormField fits it. */
export interface FormulaField {
  id: string;
  type: string;
  label: string;
  key?: string;
  formula?: string;
  items?: { id: string }[];
  /** A scrap field's: "rows" (people enter them) or "formula" (an output). */
  source?: string;
}

/** Whether a formula can read this field. */
function readable(field: FormulaField): boolean {
  if (field.type === "scrap") return field.source !== "formula";
  return FORMULA_INPUT_TYPES.has(field.type);
}

export interface ParsedFormula {
  compiled: EvalFunction | null;
  /** Field keys the formula reads, in first-use order. */
  refs: string[];
  error: string | null;
}

function checkNode(node: MathNode, path: string | null): string | null {
  switch (node.type) {
    case "ConstantNode": {
      const value = (node as ConstantNode).value;
      return typeof value === "number" || typeof value === "boolean"
        ? null
        : "Only numbers, true and false can be written in a formula";
    }
    case "SymbolNode": {
      const name = (node as SymbolNode).name;
      if (path === "fn") return FUNCTIONS.has(name) ? null : `There's no function "${name}"`;
      return null;
    }
    case "OperatorNode":
      return OPERATORS.has((node as OperatorNode).fn as string)
        ? null
        : `"${(node as OperatorNode).op}" can't be used in a formula`;
    case "ParenthesisNode":
    case "ConditionalNode":
    case "FunctionNode":
      return null;
    default:
      return "That isn't something a formula can do";
  }
}

const parsedCache = new Map<string, ParsedFormula>();

/** Syntax and allowed operations only; which names exist is the form's business. */
export function parseFormula(formula: string): ParsedFormula {
  const hit = parsedCache.get(formula);
  if (hit) return hit;
  const result = parseUncached(formula);
  if (parsedCache.size >= 500) parsedCache.clear();
  parsedCache.set(formula, result);
  return result;
}

function parseUncached(formula: string): ParsedFormula {
  if (formula.trim() === "") return { compiled: null, refs: [], error: "Write a formula" };
  if (formula.length > MAX_FORMULA_LENGTH) {
    return { compiled: null, refs: [], error: `A formula can be at most ${MAX_FORMULA_LENGTH} characters` };
  }
  let root: MathNode;
  try {
    root = math.parse(formula);
  } catch {
    return { compiled: null, refs: [], error: "The formula isn't complete" };
  }
  let count = 0;
  let error: string | null = null;
  const refs: string[] = [];
  root.traverse((node, path) => {
    count += 1;
    error ??= checkNode(node, path);
    if (node.type === "SymbolNode" && path !== "fn") {
      const name = (node as SymbolNode).name;
      if (!refs.includes(name)) refs.push(name);
    }
  });
  if (count > MAX_NODES) error ??= "The formula is too long";
  if (error) return { compiled: null, refs, error };
  return { compiled: root.compile(), refs, error: null };
}

function keyed(fields: FormulaField[]): Map<string, FormulaField> {
  const byKey = new Map<string, FormulaField>();
  for (const field of fields) if (field.key) byKey.set(field.key, field);
  return byKey;
}

/**
 * Problems with a computed field's formula on this form: bad syntax, a name
 * no field has, a field a formula can't read, or itself. Cycles between
 * computed fields are `formulaCycle`'s business.
 */
export function formulaProblem(field: FormulaField, fields: FormulaField[]): string | null {
  const parsed = parseFormula(field.formula ?? "");
  if (parsed.error) return parsed.error;
  const byKey = keyed(fields);
  for (const ref of parsed.refs) {
    const target = byKey.get(ref);
    if (!target) return `No field is named "${ref}"`;
    if (target.id === field.id) return "A formula can't use its own result";
    if (!readable(target)) {
      return `"${target.label || ref}" can't be used in a formula yet`;
    }
  }
  return null;
}

/** The computed fields that depend on each other in a loop; empty when there is none. */
export function formulaCycle<F extends FormulaField>(fields: F[]): F[] {
  const computed = fields.filter((f) => f.type === "computed");
  const byKey = new Map<string, F>();
  for (const field of computed) if (field.key) byKey.set(field.key, field);
  const state = new Map<string, "visiting" | "done">();
  const stack: F[] = [];
  const visit = (field: F): F[] | null => {
    if (state.get(field.id) === "done") return null;
    if (state.get(field.id) === "visiting") return stack.slice(stack.indexOf(field));
    state.set(field.id, "visiting");
    stack.push(field);
    for (const ref of parseFormula(field.formula ?? "").refs) {
      const next = byKey.get(ref);
      const loop = next && visit(next);
      if (loop) return loop;
    }
    stack.pop();
    state.set(field.id, "done");
    return null;
  };
  for (const field of computed) {
    const loop = visit(field);
    if (loop) return loop;
  }
  return [];
}

export type FormulaValue = number | boolean | null;

export interface ComputedResult {
  value: FormulaValue;
  /** Labels of the inputs still waiting for an answer. */
  waitingFor: string[];
  error: string | null;
}

/** A field's answer as a formula reads it; undefined while it has none. */
function inputValue(field: FormulaField, answer: unknown): number | boolean | undefined {
  switch (field.type) {
    case "number":
    case "rating":
      return typeof answer === "number" && Number.isFinite(answer) ? answer : undefined;
    case "checkbox":
      return answer === true;
    case "checklist": {
      const checked = (answer ?? {}) as Record<string, unknown>;
      return (field.items ?? []).filter((item) => checked[item.id] === true).length;
    }
    case "scrap": {
      if (field.source === "formula") return undefined;
      if (!Array.isArray(answer)) return 0;
      let total = 0;
      for (const row of answer) {
        const quantity = (row as { quantity?: unknown } | null)?.quantity;
        if (typeof quantity === "number" && Number.isFinite(quantity)) total += quantity;
      }
      return total;
    }
    default:
      return undefined;
  }
}

/** Numbers and true/false come out; anything not finite (a division by zero) is blank. */
function normalize(value: unknown): FormulaValue {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return null;
}

/**
 * Every computed field's result for these answers, keyed by field id. Each
 * formula sees the results of the computed fields it names, so they are
 * worked out in dependency order; a loop or a broken formula yields an error
 * instead of a value.
 */
export function computeAll(fields: FormulaField[], answers: Record<string, unknown>): Map<string, ComputedResult> {
  const results = new Map<string, ComputedResult>();
  const byKey = keyed(fields);
  const looping = new Set(formulaCycle(fields).map((f) => f.id));

  const evaluate = (field: FormulaField, read: (ref: string) => number | boolean | undefined): ComputedResult => {
    const parsed = parseFormula(field.formula ?? "");
    const scope: Record<string, number | boolean> = {};
    const waitingFor: string[] = [];
    for (const ref of parsed.refs) {
      const value = read(ref);
      if (value === undefined) waitingFor.push(byKey.get(ref)?.label || ref);
      else scope[ref] = value;
    }
    if (waitingFor.length > 0) return { value: null, waitingFor, error: null };
    try {
      // formulaProblem already passed, so the formula compiled.
      return { value: normalize((parsed.compiled as EvalFunction).evaluate(scope)), waitingFor: [], error: null };
    } catch {
      return { value: null, waitingFor: [], error: "The formula can't be worked out" };
    }
  };

  const resolve = (field: FormulaField): ComputedResult => {
    const known = results.get(field.id);
    if (known) return known;
    let result: ComputedResult;
    if (looping.has(field.id)) {
      result = { value: null, waitingFor: [], error: "These formulas use each other's results" };
    } else {
      const problem = formulaProblem(field, fields);
      result = problem
        ? { value: null, waitingFor: [], error: problem }
        : evaluate(field, (ref) => {
            const target = byKey.get(ref) as FormulaField;
            if (target.type !== "computed") return inputValue(target, answers[target.id]);
            const inner = resolve(target);
            return inner.value === null ? undefined : inner.value;
          });
    }
    results.set(field.id, result);
    return result;
  };

  for (const field of fields) if (field.type === "computed") resolve(field);
  return results;
}

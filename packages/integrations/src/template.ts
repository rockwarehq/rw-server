import { errorResult, type IntegrationResult } from "./types.js";

// A trigger's action input is literal JSON with `{ "$from": "field" }` nodes
// pulling values off the event payload.
// Not string interpolation: `{{token}}` stringifies, so numbers round-trip
// through text, null becomes "", and a typo renders empty instead of failing.

const MAX_DEPTH = 20;

export interface TemplateBinding {
  $from: string;
  $default?: unknown;
}

export function isTemplateBinding(value: unknown): value is TemplateBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as TemplateBinding).$from === "string"
  );
}

/** Resolve every `$from` against `payload`; absent falls back to `$default`, else errors. */
export function resolveInputTemplate(template: unknown, payload: Record<string, unknown>): IntegrationResult<unknown> {
  try {
    return { data: resolve(template, payload, 0) };
  } catch (err) {
    return errorResult(
      "TEMPLATE_FIELD_MISSING",
      err instanceof Error ? err.message : "Action input template could not be resolved",
    );
  }
}

/** Every payload field the template reads — for validating a trigger against a hook's declared context. */
export function templateFieldNames(template: unknown): string[] {
  const fields = new Set<string>();
  collect(template, fields, 0);
  return [...fields];
}

function resolve(node: unknown, payload: Record<string, unknown>, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error("Action input template is nested too deeply");

  if (isTemplateBinding(node)) {
    if (node.$from in payload) return payload[node.$from];
    if ("$default" in node) return node.$default;
    throw new Error(`Event payload has no field "${node.$from}"`);
  }

  if (Array.isArray(node)) return node.map((item) => resolve(item, payload, depth + 1));

  if (typeof node === "object" && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = resolve(value, payload, depth + 1);
    return out;
  }

  return node;
}

function collect(node: unknown, fields: Set<string>, depth: number): void {
  if (depth > MAX_DEPTH) return;

  if (isTemplateBinding(node)) {
    fields.add(node.$from);
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) collect(item, fields, depth + 1);
    return;
  }

  if (typeof node === "object" && node !== null) {
    for (const value of Object.values(node)) collect(value, fields, depth + 1);
  }
}

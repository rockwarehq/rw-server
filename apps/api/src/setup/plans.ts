import { randomUUID } from "node:crypto";
import { call, ORPCError } from "@orpc/server";
import type { RPCContext } from "../rpc/context.js";
import { inputSchemaAt, resolveAction } from "./catalog.js";
import type { Level } from "./manifest.js";

// Change plans: the only way the setup assistant changes anything.
//
// The AI proposes a plan (a list of steps, each one catalog action with its
// input). The server checks every step and keeps the plan for a while. The
// person reviews it on a card and presses Apply; only then does applyPlan run
// the steps, one after another, by calling the real procedures in-process
// with the person's own context, so every access check still applies. No AI
// is involved in applying.
//
// A step can use what an earlier step made: "$wc1" is the id step "wc1"
// created, "$wc1.name" any other field of its result. So one plan can make a
// workcenter and put new stations in it.

export interface PlanStep {
  /** A short name other steps can refer to, like "wc1". */
  id: string;
  /** A catalog action (router path), like "station.create". */
  action: string;
  input: Record<string, unknown>;
  /** One line saying what this step does, for the person. */
  note?: string;
}

export interface StoredPlan {
  id: string;
  userId: string;
  siteId: string;
  title: string;
  steps: Array<PlanStep & { summary: string; danger?: string; level: Level; kind: string }>;
  createdAt: number;
  appliedAt?: number;
}

export interface StepResult {
  stepId: string;
  ok: boolean;
  /** The id the step made or changed, when it has one. */
  resultId?: string;
  error?: string;
}

const PLAN_TTL_MS = 60 * 60 * 1000;
const MAX_STEPS = 60;
const plans = new Map<string, StoredPlan>();

// Plans live in this API process's memory for an hour. Fine for one server;
// with several, keep them in Redis instead.
function sweep(now = Date.now()) {
  for (const [id, plan] of plans) if (now - plan.createdAt > PLAN_TTL_MS) plans.delete(id);
}

const REF = /^\$([a-zA-Z0-9_-]+)(?:\.([a-zA-Z0-9_]+))?$/;

/** Replace "$step" and "$step.field" strings, anywhere in the input, with values. */
function substitute(value: unknown, lookup: (step: string, field: string) => unknown): unknown {
  if (typeof value === "string") {
    const m = REF.exec(value);
    return m ? lookup(m[1]!, m[2] ?? "id") : value;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, lookup));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, lookup)]));
  }
  return value;
}

/** Every "$step" a step's input refers to. */
function refsIn(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const m = REF.exec(value);
    if (m) out.add(m[1]!);
  } else if (Array.isArray(value)) {
    for (const v of value) refsIn(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) refsIn(v, out);
  }
  return out;
}

const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

/** Can this person do things at this level at this plant? The server still checks each call. */
function allowed(context: RPCContext, level: Level, siteId: string): boolean {
  const current = context.current;
  if (!current || current.kind !== "user") return false;
  try {
    if (level === "ACCOUNT_ADMIN") {
      context.access.requireAccountAdmin();
      return true;
    }
    return context.access.can(level, { site: siteId });
  } catch {
    return false;
  }
}

/**
 * Check a proposed plan and keep it for the person to approve. Returns the
 * stored plan, or the problems to send back to the AI.
 */
export async function proposePlan(
  context: RPCContext,
  siteId: string,
  title: string,
  steps: PlanStep[],
): Promise<{ plan: StoredPlan } | { problems: string[] }> {
  sweep();
  const problems: string[] = [];
  if (steps.length === 0) problems.push("A plan needs at least one step.");
  if (steps.length > MAX_STEPS)
    problems.push(`Keep a plan to ${MAX_STEPS} steps; split bigger jobs into several plans.`);
  const seen = new Set<string>();
  const checked: StoredPlan["steps"] = [];
  for (const [i, step] of steps.entries()) {
    const where = `step ${i + 1} (${step.id})`;
    if (seen.has(step.id)) problems.push(`${where}: two steps are called ${step.id}.`);
    const action = await resolveAction(step.action);
    if (!action) {
      problems.push(`${where}: ${step.action} isn't a setup action. Use list_setup to find one.`);
      continue;
    }
    if (action.kind === "read") problems.push(`${where}: ${step.action} only reads; use the read tool, not a plan.`);
    for (const ref of refsIn(step.input)) {
      if (!seen.has(ref)) problems.push(`${where}: refers to $${ref}, which isn't an earlier step.`);
    }
    if (!allowed(context, action.level, siteId)) {
      problems.push(`${where}: you need ${action.level.toLowerCase().replace("_", " ")} access for ${step.action}.`);
    }
    // Check the input against the procedure's own rules, with made-up ids for earlier steps.
    const schema = await inputSchemaAt(step.action);
    if (schema) {
      const trial = substitute(step.input, () => PLACEHOLDER_ID);
      const parsed = schema.safeParse(trial);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
        problems.push(`${where} ${step.action}: ${issues.join("; ")}`);
      }
    }
    seen.add(step.id);
    checked.push({
      ...step,
      summary: action.summary,
      level: action.level,
      kind: action.kind,
      ...(action.danger ? { danger: action.danger } : {}),
    });
  }
  if (problems.length > 0) return { problems };
  const current = context.current as { user: { id: string } };
  const plan: StoredPlan = {
    id: randomUUID(),
    userId: current.user.id,
    siteId,
    title,
    steps: checked,
    createdAt: Date.now(),
  };
  plans.set(plan.id, plan);
  return { plan };
}

/** A plan this person may apply, or why not. */
export function planFor(planId: string, userId: string): StoredPlan | { error: string } {
  sweep();
  const plan = plans.get(planId);
  if (!plan || plan.userId !== userId)
    return { error: "This plan has expired or isn't yours. Ask the assistant again." };
  if (plan.appliedAt) return { error: "This plan was already applied." };
  return plan;
}

/** The id a procedure's result carries, if any. */
function idOf(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as { id?: unknown; data?: { id?: unknown } };
  if (typeof r.id === "string") return r.id;
  if (r.data && typeof r.data.id === "string") return r.data.id;
  return undefined;
}

function fieldOf(result: unknown, field: string): unknown {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown> & { data?: Record<string, unknown> };
  return field === "id" ? idOf(result) : (r[field] ?? r.data?.[field]);
}

function errorWords(error: unknown): string {
  if (error instanceof ORPCError) return error.message || error.code;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/**
 * Run a plan's steps in order, as the person. Stops at the first failure;
 * steps already done stay done (there's no undo across procedures), and the
 * results say exactly which ones ran. Dangerous steps run only when the
 * person ticked them.
 */
export async function* applyPlan(
  context: RPCContext,
  plan: StoredPlan,
  confirmed: Set<string>,
): AsyncGenerator<StepResult | { skipped: string; reason: string }> {
  plan.appliedAt = Date.now();
  const results = new Map<string, unknown>();
  for (const step of plan.steps) {
    if (step.danger && !confirmed.has(step.id)) {
      yield { skipped: step.id, reason: "Not confirmed." };
      continue;
    }
    const action = await resolveAction(step.action);
    if (!action) {
      yield { stepId: step.id, ok: false, error: `${step.action} no longer exists.` };
      return;
    }
    let missing: string | undefined;
    const input = substitute(step.input, (ref, field) => {
      const value = results.has(ref) ? fieldOf(results.get(ref), field) : undefined;
      if (value === undefined) missing ??= `$${ref}${field === "id" ? "" : `.${field}`}`;
      return value;
    });
    if (missing) {
      yield { stepId: step.id, ok: false, error: `It needs ${missing}, which an earlier step didn't make.` };
      return;
    }
    try {
      const result = await call(action.proc, input, { context });
      results.set(step.id, result);
      const resultId = idOf(result);
      yield { stepId: step.id, ok: true, ...(resultId ? { resultId } : {}) };
    } catch (error) {
      yield { stepId: step.id, ok: false, error: errorWords(error) };
      return;
    }
  }
}

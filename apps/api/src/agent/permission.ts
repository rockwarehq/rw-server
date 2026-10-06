import { z } from "zod";

// Agent permissions, after opencode's: a rule maps a permission key and a
// pattern to allow / ask / deny. Rulesets are layered (built-in defaults,
// then the agent, then the site's saved answers, then the session) and the
// LAST matching rule wins, so later layers refine earlier ones. No match
// means ask: anything nobody decided needs a person.

export const permissionActionSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionAction = z.infer<typeof permissionActionSchema>;

export const permissionRuleSchema = z.object({
  permission: z.string().min(1).max(100),
  pattern: z.string().min(1).max(500).default("*"),
  action: permissionActionSchema,
});
export type PermissionRule = z.infer<typeof permissionRuleSchema>;
export type Ruleset = readonly PermissionRule[];

// Glob match: "*" is any run of characters, everything else literal.
export function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(value);
}

export function evaluate(rulesets: readonly Ruleset[], permission: string, pattern: string): PermissionAction {
  const rules = rulesets.flat();
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index];
    if (wildcardMatch(rule.permission, permission) && wildcardMatch(rule.pattern, pattern)) return rule.action;
  }
  return "ask";
}

// A tool call names several resources (patterns); the strictest answer wins.
export function evaluateAll(
  rulesets: readonly Ruleset[],
  permission: string,
  patterns: readonly string[],
): PermissionAction {
  const actions = (patterns.length ? patterns : ["*"]).map((pattern) => evaluate(rulesets, permission, pattern));
  if (actions.includes("deny")) return "deny";
  if (actions.includes("ask")) return "ask";
  return "allow";
}

// A tool is hidden from the model only when it can never be used: the last
// catch-all ("*" pattern) rule for its permission denies, and no later rule
// allows or asks for some specific pattern. Partly denied tools stay visible
// and refuse at call time with a reason the model can read.
export function isHidden(rulesets: readonly Ruleset[], permission: string): boolean {
  const rules = rulesets.flat().filter((rule) => wildcardMatch(rule.permission, permission));
  let lastCatchAll = -1;
  rules.forEach((rule, index) => {
    if (rule.pattern === "*") lastCatchAll = index;
  });
  if (lastCatchAll === -1 || rules[lastCatchAll].action !== "deny") return false;
  return rules.slice(lastCatchAll + 1).every((rule) => rule.action === "deny");
}

// A child run (subagent) may never do what its parent was denied, and it
// can't stop to ask a person: its asks become denies.
export function capForChild(parent: readonly Ruleset[], child: readonly Ruleset[]): Ruleset[] {
  const parentDenies = parent.flat().filter((rule) => rule.action === "deny");
  const childRules = child.flat().map((rule) => (rule.action === "ask" ? { ...rule, action: "deny" as const } : rule));
  return [[{ permission: "*", pattern: "*", action: "deny" }], childRules, parentDenies];
}

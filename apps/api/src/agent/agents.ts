import prisma from "@rw/db";

import { agentConfig } from "../config.js";
import { type PermissionRule, permissionRuleSchema, type Ruleset } from "./permission.js";

// Agents as config. Built-ins ship in code; a site's custom agents
// (AgentDefinition) extend one of them and override instructions, model,
// step budget and permission rules. The runtime only ever sees a
// ResolvedAgent.

export interface ResolvedAgent {
  key: string;
  baseKey: string;
  name: string;
  description: string;
  builtIn: boolean;
  version: number;
  enabled: boolean;
  instructions: string | null;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxSteps: number;
  /** Layered: shared defaults, the base agent, the custom agent. */
  rulesets: Ruleset[];
  /** Built-ins other agents may delegate to with the task tool. */
  subagent: boolean;
  notificationGroupId: string | null;
  runAsUserId: string | null;
}

// Shared defaults: reading the plant is fine, anything else needs a person.
const DEFAULT_RULES: PermissionRule[] = [
  { permission: "*", pattern: "*", action: "ask" },
  { permission: "graph.read", pattern: "*", action: "allow" },
  { permission: "devices.read", pattern: "*", action: "allow" },
  { permission: "catalog.read", pattern: "*", action: "allow" },
  { permission: "integrations.read", pattern: "*", action: "allow" },
  { permission: "changeset.read", pattern: "*", action: "allow" },
  { permission: "tool_output.read", pattern: "*", action: "allow" },
  { permission: "changeset.propose", pattern: "*", action: "deny" },
  { permission: "changeset.apply", pattern: "*", action: "ask" },
  { permission: "agent.task", pattern: "*", action: "deny" },
  { permission: "doom_loop", pattern: "*", action: "ask" },
];

interface BuiltIn {
  key: string;
  name: string;
  description: string;
  instructions: string | null;
  maxSteps: number;
  effort: ResolvedAgent["effort"];
  rules: PermissionRule[];
  subagent: boolean;
}

export const BUILT_IN_AGENTS: BuiltIn[] = [
  {
    key: "build",
    name: "Build",
    description:
      "Builds and repairs the live graph with the engineer: reads everything, proposes changesets, applies them once approved.",
    instructions: null,
    maxSteps: 24,
    effort: "high",
    rules: [
      { permission: "changeset.propose", pattern: "*", action: "allow" },
      { permission: "agent.task", pattern: "explore", action: "allow" },
    ],
    subagent: false,
  },
  {
    key: "explore",
    name: "Explore",
    description: "Answers questions about the plant's data layer. Read only: never proposes or applies changes.",
    instructions:
      "You are read-only. Answer from what the tools show; if a change would help, describe it for the engineer instead of proposing it.",
    maxSteps: 16,
    effort: "medium",
    rules: [],
    subagent: true,
  },
  {
    key: "investigator",
    name: "Investigator",
    description:
      "Runs when something in the plant happens (a hook fires, a schedule comes due): finds out why, reports it, and proposes a fix when the graph itself is wrong.",
    instructions: [
      "You were started by an event, not by a person, and nobody is watching the conversation.",
      "Investigate the event in <trigger_event>: what fired, what the values were, and why.",
      "Finish with a short report: what happened, the likely cause, and what should be done.",
      "If the graph itself is wrong (a bad expression, a wrong tag, a missing property), propose a changeset and request its apply; a person will review it.",
      "Don't propose changes for problems on the shop floor that the graph is correctly reporting.",
    ].join("\n"),
    maxSteps: 20,
    effort: "high",
    rules: [
      { permission: "changeset.propose", pattern: "*", action: "allow" },
      { permission: "agent.task", pattern: "explore", action: "allow" },
    ],
    subagent: false,
  },
];

const BUILT_INS = new Map(BUILT_IN_AGENTS.map((agent) => [agent.key, agent]));

function fromBuiltIn(agent: BuiltIn): ResolvedAgent {
  return {
    key: agent.key,
    baseKey: agent.key,
    name: agent.name,
    description: agent.description,
    builtIn: true,
    version: 0,
    enabled: true,
    instructions: agent.instructions,
    model: agentConfig.model,
    effort: agent.effort,
    maxSteps: agent.maxSteps,
    rulesets: [DEFAULT_RULES, agent.rules],
    subagent: agent.subagent,
    notificationGroupId: null,
    runAsUserId: null,
  };
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function parseRules(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rule) => {
    const parsed = permissionRuleSchema.safeParse(rule);
    return parsed.success ? [parsed.data] : [];
  });
}

type DefinitionRow = NonNullable<Awaited<ReturnType<typeof prisma.agentDefinition.findFirst>>>;

export function fromDefinition(row: DefinitionRow): ResolvedAgent | null {
  const base = BUILT_INS.get(row.baseKey);
  if (!base) return null;
  const resolved = fromBuiltIn(base);
  return {
    ...resolved,
    key: row.key,
    baseKey: row.baseKey,
    name: row.name,
    description: row.description ?? resolved.description,
    builtIn: false,
    version: row.version,
    enabled: row.enabled && !row.isDeleted,
    instructions: [base.instructions, row.instructions].filter(Boolean).join("\n\n") || null,
    model: row.model || resolved.model,
    effort: row.effort && EFFORTS.has(row.effort) ? (row.effort as ResolvedAgent["effort"]) : resolved.effort,
    maxSteps: row.maxSteps ?? resolved.maxSteps,
    rulesets: [...resolved.rulesets, parseRules(row.permissions)],
    subagent: false,
    notificationGroupId: row.notificationGroupId,
    runAsUserId: row.runAsUserId,
  };
}

export async function resolveAgent(siteId: string, key: string): Promise<ResolvedAgent | null> {
  const builtIn = BUILT_INS.get(key);
  if (builtIn) return fromBuiltIn(builtIn);
  const row = await prisma.agentDefinition.findFirst({ where: { siteId, key, isDeleted: false } });
  return row ? fromDefinition(row) : null;
}

export function builtInAgent(key: string): ResolvedAgent | null {
  const builtIn = BUILT_INS.get(key);
  return builtIn ? fromBuiltIn(builtIn) : null;
}

export function isBuiltInKey(key: string): boolean {
  return BUILT_INS.has(key);
}

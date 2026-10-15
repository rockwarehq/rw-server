import type { RouterClient } from "@orpc/server";
import prisma from "@rw/db";
import * as graph from "@rw/livestore/graph/index";
import { logEvent } from "@rw/services/audit/index";
import { z } from "zod";

import type { router as appRouter } from "../rpc/index.js";
import type { ResolvedAgent } from "./agents.js";
import type { DurableEvent } from "./events.js";
import { runToolHooks } from "./hooks.js";
import { evaluateAll, isHidden, type PermissionAction, type Ruleset } from "./permission.js";

// The agent's tools. Each declares the permission it needs; the runtime
// (runner, MCP) validates input, evaluates the permission against the
// agent's rules and either runs it, refuses it, or parks the run until a
// person answers. Reads go through the same oRPC procedures the Console UI
// calls, bound to the acting user, so a tool can never do more than that
// person could by hand.

export type AppRouterClient = RouterClient<typeof appRouter>;

// Results go back to the model as text, capped so one broad query can't flood
// the context. The full text is kept in the tool.completed event (up to
// STORED_RESULT_CHARS) for tool_output_read.
const MAX_RESULT_CHARS = 60_000;
const STORED_RESULT_CHARS = 1_000_000;

export interface ToolContext {
  client: AppRouterClient;
  siteId: string;
  workspaceId: string;
  sessionId: string | null;
  toolUseId: string;
  /** The person the run acts as; null for API-token callers (MCP). */
  userId: string | null;
  agent: ResolvedAgent;
  abort: AbortSignal;
  /** Set when this call runs because a person approved it. */
  approval: { repliedById: string } | null;
  requireSiteAdmin: () => Promise<void>;
  /** Runs a child agent to completion (only inside the runner). */
  runSubagent: ((agentKey: string, prompt: string) => Promise<{ childSessionId: string; text: string }>) | null;
}

export interface ToolResult {
  output: unknown;
  metadata?: Record<string, unknown>;
  /** Durable events the call adds to the session (e.g. changeset.proposed). */
  events?: DurableEvent[];
}

export interface AgentTool<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  permission: { key: string; patterns?: (input: I) => string[] };
  execute: (input: I, ctx: ToolContext) => Promise<ToolResult>;
}

function defineTool<S extends z.ZodType>(tool: {
  name: string;
  description: string;
  input: S;
  permission: { key: string; patterns?: (input: z.output<S>) => string[] };
  execute: (input: z.output<S>, ctx: ToolContext) => Promise<ToolResult>;
}): AgentTool {
  return tool as unknown as AgentTool;
}

const uuid = z.uuid();
const jsonObject = z.record(z.string(), z.unknown());
const read = (output: Promise<unknown>) => output.then((value) => ({ output: value }));

const planNode = z.object({
  ref: z.string().min(1).describe("Batch-local handle; properties target this node with nodeRef"),
  name: z.string().min(1).describe("Unique node name in the site"),
  typeRef: z.string().min(1).nullable().optional().describe("Graph type ref, e.g. @imm/station or a site type key"),
  typeContext: jsonObject.optional().describe("Values for the type's inputs (see graph_type_schema)"),
  materializeTypeFields: z.boolean().optional().describe("Create the type's field properties on the node"),
});

const planProperty = z.object({
  id: uuid.optional().describe("UUID you choose when other items in this changeset reference the property"),
  nodeId: uuid.optional().describe("Existing node id (exactly one of nodeId or nodeRef)"),
  nodeRef: z.string().min(1).optional().describe("ref of a node in this changeset"),
  name: z.string().min(1),
  resolverType: z.string().min(1).describe("tag | entity | metric | expr | window | totalizer | rollup"),
  resolver: jsonObject.describe("Resolver config; schema per resolverType is in the manifest"),
  sampleRateMs: z.number().int().positive().nullable().optional(),
});

const planHook = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  condition: jsonObject.describe(
    "{ source: { type: 'property', propertyId }, operator, value?, threshold?, minDelta? }",
  ),
  eventNamespace: z.string().min(1),
  eventName: z.string().min(1),
  eventVersion: z.string().min(1).optional(),
  eventPayload: jsonObject.optional(),
  eventContext: jsonObject.optional(),
});

export const AGENT_TOOLS: AgentTool[] = [
  defineTool({
    name: "graph_manifest",
    description:
      "The LiveStore capability manifest: resolver types with their config JSON Schemas and dependency rules, the expression language, hook operators, hook events, value types and limits. Static per deploy.",
    input: z.object({}),
    permission: { key: "graph.read" },
    execute: (_input, ctx) => read(ctx.client.graph.introspect.manifest()),
  }),
  defineTool({
    name: "graph_types_list",
    description:
      "List the graph types available in this site (built-in like @imm/station and user-defined), with their inputs, fields and facets. Types are the schema of the user's graph.",
    input: z.object({}),
    permission: { key: "graph.read" },
    execute: (_input, ctx) => read(ctx.client.graph.type.catalog({ siteId: ctx.siteId })),
  }),
  defineTool({
    name: "graph_type_schema",
    description:
      "JSON Schema for creating a node of the given type (its required inputs and what fields it materializes). Read it before proposing nodes of that type.",
    input: z.object({ typeRef: z.string().min(1) }),
    permission: { key: "graph.read" },
    execute: (input, ctx) =>
      read(ctx.client.graph.introspect.typeSchema({ siteId: ctx.siteId, typeRef: input.typeRef })),
  }),
  defineTool({
    name: "graph_search",
    description:
      "Find graph nodes by type, name (substring) and facets (exact match). Optionally return the values-bearing property ids for the given property names.",
    input: z.object({
      typeRef: z.string().min(1).optional(),
      name: z.string().optional(),
      facets: jsonObject.optional(),
      properties: z.array(z.string().min(1)).optional(),
      limit: z.number().int().min(1).max(100).default(25),
      offset: z.number().int().min(0).default(0),
    }),
    permission: { key: "graph.read" },
    execute: (input, ctx) => read(ctx.client.graph.node.query({ siteId: ctx.siteId, ...input })),
  }),
  defineTool({
    name: "graph_node_get",
    description: "One node with all its properties, including each property's resolverType and resolver config.",
    input: z.object({ nodeId: uuid }),
    permission: { key: "graph.read" },
    execute: (input, ctx) => read(ctx.client.graph.node.get({ id: input.nodeId })),
  }),
  defineTool({
    name: "graph_values",
    description: "Current value envelopes ({ value, quality, timestamp }) for up to 200 properties.",
    input: z.object({ propertyIds: z.array(uuid).min(1).max(200) }),
    permission: { key: "graph.read" },
    execute: (input, ctx) =>
      read(ctx.client.graph.introspect.values({ siteId: ctx.siteId, propertyIds: input.propertyIds })),
  }),
  defineTool({
    name: "graph_explain",
    description:
      "Explain one property: its resolver, the properties it depends on, the properties that depend on it, and its current value.",
    input: z.object({ propertyId: uuid }),
    permission: { key: "graph.read" },
    execute: (input, ctx) => read(ctx.client.graph.introspect.explain({ id: input.propertyId })),
  }),
  defineTool({
    name: "graph_diagnostics",
    description:
      "Properties whose current value is not good quality (stale, uncertain, bad, or never evaluated), with the error context the engine attached. Start here when asked what is broken.",
    input: z.object({ scanLimit: z.number().int().min(1).max(5000).default(2000) }),
    permission: { key: "graph.read" },
    execute: (input, ctx) =>
      read(ctx.client.graph.introspect.diagnostics({ siteId: ctx.siteId, scanLimit: input.scanLimit })),
  }),
  defineTool({
    name: "graph_conformance",
    description: "Nodes that don't conform to their type (missing inputs, missing or drifted fields).",
    input: z.object({}),
    permission: { key: "graph.read" },
    execute: (_input, ctx) => read(ctx.client.graph.introspect.conformance({ siteId: ctx.siteId })),
  }),
  defineTool({
    name: "graph_hooks_list",
    description: "Hooks in the site: the property condition each watches and the event it publishes.",
    input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    permission: { key: "graph.read" },
    execute: (input, ctx) => read(ctx.client.graph.hook.list({ siteId: ctx.siteId, limit: input.limit, offset: 0 })),
  }),
  defineTool({
    name: "devices_tree",
    description:
      "Gateways and their datasources (devices) in the site. Datasource ids are the deviceId a tag resolver points at.",
    input: z.object({}),
    permission: { key: "devices.read" },
    execute: (_input, ctx) => read(ctx.client.site.deviceTree({ siteId: ctx.siteId })),
  }),
  defineTool({
    name: "catalog_entities",
    description:
      "The entity catalog: system entities (Station, Workcenter, Job, ...) and user-defined entities, with their fields. Entity resolvers read these.",
    input: z.object({ key: z.string().min(1).optional() }),
    permission: { key: "catalog.read" },
    execute: (input, ctx) =>
      read(ctx.client.entity.catalog.list({ key: input.key, includeFields: true, limit: 200, offset: 0 })),
  }),
  defineTool({
    name: "integrations_list",
    description: "Outbound integrations (SQL Server, REST, webhook) configured in the site.",
    input: z.object({}),
    permission: { key: "integrations.read" },
    execute: (_input, ctx) => read(ctx.client.integration.list({ siteId: ctx.siteId })),
  }),
  defineTool({
    name: "changesets_list",
    description: "Changesets in the site (drafts awaiting review, applied, discarded).",
    input: z.object({ status: z.enum(["DRAFT", "APPLIED", "DISCARDED"]).optional() }),
    permission: { key: "changeset.read" },
    execute: (input, ctx) =>
      read(ctx.client.graph.changeset.list({ siteId: ctx.siteId, status: input.status, limit: 50 })),
  }),
  defineTool({
    name: "propose_changeset",
    description:
      "Propose graph creations (nodes, properties, hooks) as one changeset. Nothing is written to the graph. The result carries the planner's issues; when valid is false, fix them and propose again. When valid is true, call apply_changeset with its changesetId: a person reviews and approves it. Properties referenced by other items need an id you choose (a UUID); expressions reference properties as p_<uuid with dashes replaced by underscores>.",
    input: z.object({
      title: z.string().min(1).max(200).describe("Short imperative summary, e.g. 'Add OEE to Press 4'"),
      rationale: z.string().max(4000).optional().describe("Why, in a sentence or two"),
      nodes: z.array(planNode).max(50).optional(),
      properties: z.array(planProperty).max(200).optional(),
      hooks: z.array(planHook).max(50).optional(),
    }),
    permission: { key: "changeset.propose" },
    execute: async (input, ctx) => {
      if (!ctx.userId) throw new Error("Proposing a changeset requires a signed-in user");
      await ctx.requireSiteAdmin();
      const { title, rationale, ...spec } = input;
      const result = await graph.changesets.create(
        { title, rationale, spec, author: "AGENT", sessionId: ctx.sessionId, createdById: ctx.userId },
        { workspaceId: ctx.workspaceId, siteId: ctx.siteId },
      );
      if ("error" in result) throw new Error(`${result.code}: ${result.error}`);
      const changeset = result.data;
      const plan = changeset.planResult as {
        valid: boolean;
        issues: unknown[];
        properties: unknown[];
        notes: string[];
      };
      return {
        output: {
          changesetId: changeset.id,
          title: changeset.title,
          valid: plan.valid,
          issues: plan.issues,
          properties: plan.properties,
          notes: plan.notes,
          next: plan.valid ? "Call apply_changeset with this changesetId to request approval." : "Fix the issues.",
        },
        metadata: { changesetId: changeset.id, valid: plan.valid },
        events: [{ type: "changeset.proposed", changesetId: changeset.id, title: changeset.title, valid: plan.valid }],
      };
    },
  }),
  defineTool({
    name: "apply_changeset",
    description:
      "Ask a person to approve and apply a valid changeset you proposed. The run pauses until they answer. If they approve, it's applied in one transaction and you get the created ids; if they reject, you get their feedback. Apply refuses when the graph changed since the proposal: propose again.",
    input: z.object({ changesetId: uuid }),
    permission: { key: "changeset.apply", patterns: (input) => [input.changesetId] },
    execute: async (input, ctx) => {
      if (!ctx.approval) throw new Error("Applying a changeset needs a person's approval");
      const scope = { workspaceId: ctx.workspaceId, siteId: ctx.siteId };
      const result = await graph.changesets.apply(input.changesetId, scope, { appliedById: ctx.approval.repliedById });
      if ("error" in result) {
        if (result.code === "GRAPH_CHANGESET_STALE")
          throw new Error("The graph changed since this changeset was proposed; propose it again");
        throw new Error(`${result.code}: ${result.error}`);
      }
      await logEvent({
        action: "GRAPH_CHANGESET_APPLIED",
        actorId: ctx.approval.repliedById,
        workspaceId: ctx.workspaceId,
        metadata: { changesetId: input.changesetId, siteId: ctx.siteId, agentSessionId: ctx.sessionId },
      });
      return {
        output: { applied: true, changesetId: result.data.id, created: result.data.appliedResult },
        metadata: { changesetId: result.data.id },
        events: [{ type: "changeset.applied", changesetId: result.data.id, title: result.data.title }],
      };
    },
  }),
  defineTool({
    name: "task",
    description:
      "Delegate a self-contained question to a subagent (e.g. explore) that investigates on its own and returns a written answer. Use it to keep long investigations out of this conversation.",
    input: z.object({
      agent: z.string().min(1).describe("Subagent key, e.g. explore"),
      prompt: z
        .string()
        .min(1)
        .max(8000)
        .describe("Everything the subagent needs to know: it can't see this conversation"),
    }),
    permission: { key: "agent.task", patterns: (input) => [input.agent] },
    execute: async (input, ctx) => {
      if (!ctx.runSubagent) throw new Error("Subagents aren't available here");
      const child = await ctx.runSubagent(input.agent, input.prompt);
      return { output: child.text, metadata: { childSessionId: child.childSessionId } };
    },
  }),
  defineTool({
    name: "tool_output_read",
    description: "Read more of a tool result that was truncated, by its tool call id.",
    input: z.object({
      toolUseId: z.string().min(1),
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(1000).max(MAX_RESULT_CHARS).default(MAX_RESULT_CHARS),
    }),
    permission: { key: "tool_output.read" },
    execute: async (input, ctx) => {
      if (!ctx.sessionId) throw new Error("No stored output outside a session");
      const rows = await prisma.agentEvent.findMany({
        where: { sessionId: ctx.sessionId, type: { startsWith: "tool.completed." } },
        orderBy: { seq: "desc" },
        take: 200,
      });
      const row = rows.find((r) => (r.payload as { toolUseId?: string }).toolUseId === input.toolUseId);
      if (!row) throw new Error(`No stored output for ${input.toolUseId}`);
      const full = String((row.payload as { output?: unknown }).output ?? "");
      const end = input.offset + input.length;
      const rest = full.length - end;
      return { output: `${full.slice(input.offset, end)}${rest > 0 ? `\n…[${rest} more characters]` : ""}` };
    },
  }),
];

export const AGENT_TOOLS_BY_NAME = new Map(AGENT_TOOLS.map((tool) => [tool.name, tool]));

/** The tools an agent can see: not denied outright by its rules. */
export function toolsFor(rulesets: readonly Ruleset[]): AgentTool[] {
  return AGENT_TOOLS.filter((tool) => !isHidden(rulesets, tool.permission.key));
}

export function toolInputJsonSchema(tool: AgentTool): Record<string, unknown> {
  const { $schema: _schema, ...schema } = z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>;
  return schema;
}

export function serializeOutput(
  output: unknown,
  toolUseId: string,
): { model: string; stored: string; truncated: boolean } {
  const text = typeof output === "string" ? output : (JSON.stringify(output ?? null) ?? "null");
  const stored = text.slice(0, STORED_RESULT_CHARS);
  if (text.length <= MAX_RESULT_CHARS) return { model: text, stored, truncated: false };
  return {
    model: `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated: ${text.length - MAX_RESULT_CHARS} more characters. Read on with tool_output_read({ toolUseId: "${toolUseId}", offset: ${MAX_RESULT_CHARS} }), or narrow the query.]`,
    stored,
    truncated: true,
  };
}

export type ToolDecision =
  | { kind: "unknown"; error: string }
  | { kind: "invalid"; error: string }
  | { kind: "deny"; tool: AgentTool; error: string }
  | { kind: "allow" | "ask"; tool: AgentTool; input: unknown; permission: string; patterns: string[] };

/**
 * Validate a call and decide it against the agent's rules. Applying a
 * changeset is never decided by a rule: it always needs a person.
 */
export function decideToolCall(name: string, rawInput: unknown, rulesets: readonly Ruleset[]): ToolDecision {
  const tool = AGENT_TOOLS_BY_NAME.get(name);
  if (!tool || isHidden(rulesets, tool.permission.key)) return { kind: "unknown", error: `Unknown tool ${name}` };
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`)
      .join("; ");
    return {
      kind: "invalid",
      error: `The input for ${name} doesn't match its schema (${issues}). Rewrite the input so it satisfies the schema and call again.`,
    };
  }
  const patterns = tool.permission.patterns?.(parsed.data) ?? ["*"];
  let action: PermissionAction = evaluateAll(rulesets, tool.permission.key, patterns);
  if (tool.permission.key === "changeset.apply" && action === "allow") action = "ask";
  if (action === "deny") {
    return {
      kind: "deny",
      tool,
      error: `This agent isn't allowed to ${tool.permission.key} (${patterns.join(", ")}).`,
    };
  }
  return { kind: action, tool, input: parsed.data, permission: tool.permission.key, patterns };
}

/** Run an allowed (or approved) call through the hooks. Throws on failure. */
export async function executeToolCall(tool: AgentTool, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  return runToolHooks(tool, input, ctx, () => tool.execute(input, ctx));
}

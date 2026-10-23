import { createRouterClient } from "@orpc/server";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Current, UserCurrent } from "@rw/auth/context";
import prisma from "@rw/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { loadUserCurrent } from "../auth/plugin.js";
import { agentConfig, mcpConfig } from "../config.js";
import { apiOrigin, protectedResourceMetadataUrl } from "../oauth/routes.js";
import { OAUTH_ACCESS_PREFIX, resolveAccessToken } from "../oauth/store.js";
import { builtInAgent, type ResolvedAgent } from "./agents.js";
import type { Ruleset } from "./permission.js";
import {
  type AppRouterClient,
  decideToolCall,
  executeToolCall,
  serializeOutput,
  toolInputJsonSchema,
  toolsFor,
} from "./tools.js";

// The agents' tools over MCP (Streamable HTTP, stateless). Two kinds of
// caller:
//
// - A person's own agent, connected with OAuth (Claude Code, Cursor, ...):
//     claude mcp add --transport http rockware https://<api>/mcp
//   The agent discovers our authorization server from the 401, the person
//   approves it on IMM's consent page for one plant, and its token resolves
//   to that person with `via` set. Only IMM reads (and setup proposals when
//   granted) are offered, and the RPC layer admits it only to the procedures
//   listed for its scopes. The plant must allow agent connections.
// - A user session token or a graph:read API token (AGENTS_ENABLED only):
//   the build agent's rules (explore's for API tokens), for engineers on
//   Console's graph.
//
// Tools run as the caller through the same procedures the UI calls. There's
// no person in this loop to ask, so anything that would ask is refused:
// changesets can be proposed but never applied over MCP.

/** What a connected agent may use: IMM reads, and setup proposals if granted. */
export function connectedAgentRules(scopes: readonly string[]): Ruleset {
  return [
    { permission: "*", pattern: "*", action: "deny" },
    ...(scopes.includes("read") ? [{ permission: "imm.read", pattern: "*", action: "allow" as const }] : []),
    ...(scopes.includes("setup:propose")
      ? [{ permission: "setup.propose", pattern: "*", action: "allow" as const }]
      : []),
  ];
}

function agentFor(current: Current): ResolvedAgent {
  const base = builtInAgent(current.kind === "user" && !current.via ? "build" : "explore");
  if (!base) throw new Error("unreachable: built-in agents exist");
  if (current.kind === "user" && current.via) {
    return { ...base, rulesets: [connectedAgentRules(current.via.scopes)] };
  }
  // Without our agent runtime, the graph surface isn't served at all: every
  // caller gets the connected-agent view, read only.
  if (!agentConfig.available) return { ...base, rulesets: [connectedAgentRules(["read"])] };
  return base;
}

function mcpServerFor(request: FastifyRequest, current: Current, siteId: string): Server {
  const server = new Server({ name: "rockware", version: "1.0.0" }, { capabilities: { tools: {} } });
  const agent = agentFor(current);
  // Subagents need the runner; nothing here may wait for a person.
  const rulesets: Ruleset[] = [...agent.rulesets, [{ permission: "agent.task", pattern: "*", action: "deny" }]];
  const tools = toolsFor(rulesets);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toolInputJsonSchema(tool) as { type: "object" },
      // ChatGPT asks for all three hints to decide which calls need the person's OK.
      annotations: {
        readOnlyHint: tool.permission.key.endsWith(".read"),
        destructiveHint: tool.destructive ?? false,
        openWorldHint: false,
      },
      ...(tool.meta ? { _meta: tool.meta } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    const decision = decideToolCall(call.params.name, call.params.arguments ?? {}, rulesets);
    if (decision.kind === "unknown" || decision.kind === "invalid" || decision.kind === "deny") {
      return { isError: true, content: [{ type: "text", text: decision.error }] };
    }
    if (decision.kind === "ask") {
      return {
        isError: true,
        content: [
          { type: "text", text: `${decision.permission} needs a person's approval; do it in Rockware Console.` },
        ],
      };
    }

    const { router } = await import("../rpc/index.js");
    const client = createRouterClient(router, {
      context: { request, current, access: current.access },
    }) as AppRouterClient;
    try {
      const result = await executeToolCall(decision.tool, decision.input, {
        client,
        siteId,
        workspaceId: current.workspaceId,
        sessionId: null,
        toolUseId: "mcp",
        userId: current.kind === "user" ? current.user.id : null,
        agent,
        abort: new AbortController().signal,
        approval: null,
        requireSiteAdmin: async () => {
          await current.access.require("ADMIN", { site: siteId });
        },
        apiOrigin: apiOrigin(request),
        runSubagent: null,
      });
      return { content: [{ type: "text", text: serializeOutput(result.output, "mcp").model }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  });

  return server;
}

function unauthorized(request: FastifyRequest, reply: FastifyReply, error?: "invalid_token") {
  // The 401 is how an OAuth-capable agent finds our authorization server.
  if (mcpConfig.connections) {
    const params = [`resource_metadata="${protectedResourceMetadataUrl(request)}"`];
    if (error) params.push(`error="${error}"`);
    reply.header("www-authenticate", `Bearer ${params.join(", ")}`);
  }
  return reply
    .status(401)
    .send({ error: error === "invalid_token" ? "Invalid or expired token" : "Bearer token required" });
}

type McpCaller =
  | { kind: "ok"; current: Current }
  | { kind: "unauthorized" }
  | { kind: "invalid" }
  | { kind: "plant_off" };

/** A connected agent's token: the person it acts for, with `via` set. */
async function connectedCaller(token: string): Promise<McpCaller> {
  if (!mcpConfig.connections) return { kind: "invalid" };
  const resolved = await resolveAccessToken(token);
  if (!resolved) return { kind: "invalid" };
  const site = await prisma.site.findUnique({
    where: { id: resolved.siteId },
    select: { agentConnections: true },
  });
  if (!site?.agentConnections) return { kind: "plant_off" };
  // Same checks as a signed-in request: active, unlocked, still sees the site.
  const person = await loadUserCurrent(resolved.userId, resolved.workspaceId, resolved.siteId);
  if (!person || person.kind !== "user" || person.user.mustChangePassword) return { kind: "invalid" };
  const current: UserCurrent = {
    ...person,
    via: {
      kind: "oauth",
      grantId: resolved.grantId,
      clientId: resolved.clientId,
      clientName: resolved.clientName,
      scopes: resolved.scopes,
    },
  };
  return { kind: "ok", current };
}

async function mcpCaller(request: FastifyRequest): Promise<McpCaller> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return { kind: "unauthorized" };
  const token = header.slice("Bearer ".length);
  if (token.startsWith(OAUTH_ACCESS_PREFIX)) return connectedCaller(token);
  // Session and API tokens are our own runtime's callers.
  if (!agentConfig.available) return { kind: "invalid" };
  return request.current ? { kind: "ok", current: request.current } : { kind: "invalid" };
}

async function handleMcp(request: FastifyRequest, reply: FastifyReply) {
  const caller = await mcpCaller(request);
  if (caller.kind === "unauthorized") return unauthorized(request, reply);
  if (caller.kind === "invalid") return unauthorized(request, reply, "invalid_token");
  if (caller.kind === "plant_off") {
    return reply.status(403).send({ error: "Agent connections are turned off for this plant" });
  }
  const current = caller.current;
  const siteId = current.siteId;
  if (!siteId) return reply.status(400).send({ error: "Token is not bound to a site; switch to a site first" });
  await current.access.require("VIEW", { site: siteId });

  const server = mcpServerFor(request, current, siteId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  reply.hijack();
  reply.raw.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request.raw, reply.raw, request.body);
}

export function registerMcpRoute(server: FastifyInstance) {
  // As a plugin, like the other route groups, so it registers at ready().
  void server.register(async (instance) => {
    instance.post("/mcp", handleMcp);
  });
}

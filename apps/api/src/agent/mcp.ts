import { createRouterClient } from "@orpc/server";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { builtInAgent } from "./agents.js";
import type { Ruleset } from "./permission.js";
import {
  type AppRouterClient,
  decideToolCall,
  executeToolCall,
  serializeOutput,
  toolInputJsonSchema,
  toolsFor,
} from "./tools.js";

// The agents' tools over MCP (Streamable HTTP, stateless), so an engineer
// can point Claude Code or Claude Desktop at their plant:
//
//   claude mcp add --transport http rockware https://<api>/mcp \
//     --header "Authorization: Bearer rw_app_..."
//
// The bearer is a user session token or a graph:read API token; either is
// bound to one site. Tools run as that caller through the same procedures the
// Console UI calls, under the build agent's rules (explore's for API tokens).
// There's no person in this loop to ask, so anything that would ask is
// refused: changesets can be proposed but never applied over MCP.

function mcpServerFor(request: FastifyRequest, siteId: string): Server {
  const server = new Server({ name: "rockware", version: "1.0.0" }, { capabilities: { tools: {} } });
  const current = request.current;
  if (!current) throw new Error("unreachable: /mcp requires a caller");
  const agent = builtInAgent(current.kind === "user" ? "build" : "explore");
  if (!agent) throw new Error("unreachable: built-in agents exist");
  // Subagents need the runner; nothing here may wait for a person.
  const rulesets: Ruleset[] = [...agent.rulesets, [{ permission: "agent.task", pattern: "*", action: "deny" }]];
  const tools = toolsFor(rulesets);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toolInputJsonSchema(tool) as { type: "object" },
      annotations: { readOnlyHint: tool.permission.key.endsWith(".read") },
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
      context: { request, current, access: request.access },
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
          await request.access.require("ADMIN", { site: siteId });
        },
        runSubagent: null,
      });
      return { content: [{ type: "text", text: serializeOutput(result.output, "mcp").model }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  });

  return server;
}

async function handleMcp(request: FastifyRequest, reply: FastifyReply) {
  const current = request.current;
  if (!current) return reply.status(401).send({ error: "Bearer token required" });
  const siteId = current.siteId;
  if (!siteId) return reply.status(400).send({ error: "Token is not bound to a site; switch to a site first" });
  await request.access.require("VIEW", { site: siteId });

  const server = mcpServerFor(request, siteId);
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

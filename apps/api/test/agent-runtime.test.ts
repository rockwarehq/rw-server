import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY ??= "test-key";
});

import { readEvents } from "../src/agent/events.js";
import { drainLocalRuns, setRunner } from "../src/agent/queue.js";
import { runSession, setAnthropicClient } from "../src/agent/runner.js";
import { appendMessage, history } from "../src/agent/sessions.js";
import { fireHookEvent } from "../src/agent/triggers.js";
import { makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const ADMIN_EMAIL = "agent-runtime-admin@test.local";
const VIEWER_EMAIL = "agent-runtime-viewer@test.local";
const PASSWORD = "agent-runtime-password-1";
const PREFIX = `ar-${Date.now()}`;

type Params = { system: Array<{ text: string }>; messages: BetaMessageParam[]; tools?: Array<{ name: string }> };

// A scripted model: replies are chosen from the conversation so far, so the
// same "model" drives every scenario.
function lastToolResult(params: Params): { content: string; isError: boolean } | null {
  const last = params.messages[params.messages.length - 1];
  if (last.role !== "user" || !Array.isArray(last.content)) return null;
  const result = last.content.find((block) => block.type === "tool_result") as
    | { content: unknown; is_error?: boolean }
    | undefined;
  return result ? { content: String(result.content), isError: Boolean(result.is_error) } : null;
}

function firstUserText(params: Params): string {
  const first = params.messages[0];
  if (typeof first.content === "string") return first.content;
  return first.content.map((block) => ("text" in block ? block.text : "")).join("");
}

const seenToolInputs: Array<{ name: string; content: string }> = [];

function respond(params: Params): Partial<BetaMessage> {
  const system = params.system.map((block) => block.text).join("");
  const prompt = firstUserText(params);
  const result = lastToolResult(params);
  const call = (name: string, input: unknown) => ({
    stop_reason: "tool_use" as const,
    content: [{ type: "tool_use", id: `toolu_${randomUUID().slice(0, 12)}`, name, input }] as BetaMessage["content"],
  });
  const say = (text: string) => ({
    stop_reason: "end_turn" as const,
    content: [{ type: "text", text, citations: null }] as BetaMessage["content"],
  });
  if (result) seenToolInputs.push({ name: prompt, content: result.content });

  if (system.includes("You are the Explore agent")) {
    if (prompt.includes("PROPOSE")) return result ? say(`explore saw: ${result.content}`) : call("propose_changeset", { title: "x" });
    return result ? say("Explore found 3 nodes.") : call("graph_search", { limit: 3 });
  }
  if (prompt.includes("<trigger_event>")) return result ? say("Investigated the hook.") : call("graph_diagnostics", {});
  if (prompt.includes("DELEGATE")) return result ? say(`Subagent said: ${result.content}`) : call("task", { agent: "explore", prompt: "Count nodes" });
  if (prompt.includes("BUILD")) {
    if (!result) {
      const id = randomUUID();
      return call("propose_changeset", {
        title: `${PREFIX} ${prompt.includes("REJECT") ? "rejected" : "applied"}`,
        nodes: [{ ref: "n", name: `${PREFIX}-${prompt.includes("REJECT") ? "rej" : "ok"}` }],
        properties: [{ id, nodeRef: "n", name: "target", resolverType: "expr", resolver: { expression: "42" } }],
      });
    }
    const proposed = /"changesetId":"([0-9a-f-]{36})"/.exec(result.content);
    if (proposed && result.content.includes('"valid":true')) return call("apply_changeset", { changesetId: proposed[1] });
    return say(result.isError ? `Revising after: ${result.content}` : "Applied and verified.");
  }
  return say("Hello.");
}

function scriptedClient(): Anthropic {
  return {
    beta: {
      messages: {
        stream: (params: Params) => {
          const message = {
            id: "msg",
            model: "claude-opus-5",
            role: "assistant",
            type: "message",
            usage: { input_tokens: 10, output_tokens: 5 },
            ...respond(params),
          } as BetaMessage;
          return {
            async *[Symbol.asyncIterator]() {},
            finalMessage: async () => message,
          };
        },
      },
    },
  } as unknown as Anthropic;
}

// Tier 2: the agent runtime end to end (chat, approvals, subagents, triggers,
// recovery) against Postgres, with the run queue in-process.
describe.skipIf(!process.env.TEST_DATABASE_URL)("agent runtime (Tier 2)", () => {
  let server: TestServer;
  let siteId: string;
  let adminId: string;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    setAnthropicClient(scriptedClient());
    setRunner((sessionId) => runSession(sessionId));
    server = buildServer();
    await server.ready();
    const site = await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true } });
    siteId = site.id;
    adminId = (await makeUser(ADMIN_EMAIL, PASSWORD, { plants: [{ siteId, level: "ADMIN" }] })).userId;
    await makeUser(VIEWER_EMAIL, PASSWORD, { plants: [{ siteId, level: "VIEW" }] });
    adminToken = (await loginAs(server, ADMIN_EMAIL, PASSWORD)).accessToken;
    viewerToken = (await loginAs(server, VIEWER_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    setRunner(null);
    setAnthropicClient(null);
    await prisma.agentSession.deleteMany({ where: { siteId, OR: [{ title: { contains: "BUILD" } }, { trigger: { not: "CHAT" } }, { actorUserId: adminId }] } });
    await prisma.agentTrigger.deleteMany({ where: { siteId, name: { startsWith: PREFIX } } });
    await prisma.agentDefinition.deleteMany({ where: { siteId, key: { startsWith: "ar-" } } });
    await prisma.graphChangeset.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.graphNode.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { in: [ADMIN_EMAIL, VIEWER_EMAIL] } } });
    await server.close();
  });

  async function prompt(message: string, extra: Record<string, unknown> = {}, token = adminToken) {
    const res = await rpcCall(server, "agent/prompt", { siteId, inputId: randomUUID(), message, ...extra }, token);
    expect(res.statusCode).toBe(200);
    await drainLocalRuns();
    return (res.json as { sessionId: string }).sessionId;
  }

  const eventTypes = async (sessionId: string) => (await readEvents(sessionId, 0, 1000)).map((e) => e.type);
  const status = async (sessionId: string) =>
    (await prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } })).status;

  it("parks for approval, applies once approved, and lets the agent continue", async () => {
    const sessionId = await prompt("BUILD a target node");
    expect(await status(sessionId)).toBe("WAITING_APPROVAL");
    const pending = (await rpcCall(server, "agent/approval/list", { siteId, sessionId }, adminToken)).json as Array<{
      id: string;
      permission: string;
      metadata: { title?: string };
    }>;
    expect(pending).toHaveLength(1);
    expect(pending[0].permission).toBe("changeset.apply");
    expect(pending[0].metadata.title).toContain(PREFIX);

    // Plant members can't approve graph changes.
    const denied = await rpcCall(server, "agent/approval/reply", { siteId, requestId: pending[0].id, reply: "once" }, viewerToken);
    expect(denied.statusCode).toBe(403);
    // Changesets are approved one at a time.
    const always = await rpcCall(server, "agent/approval/reply", { siteId, requestId: pending[0].id, reply: "always" }, adminToken);
    expect(always.statusCode).toBe(400);

    const ok = await rpcCall(server, "agent/approval/reply", { siteId, requestId: pending[0].id, reply: "once" }, adminToken);
    expect(ok.statusCode).toBe(200);
    await drainLocalRuns();

    expect(await status(sessionId)).toBe("IDLE");
    const types = await eventTypes(sessionId);
    expect(types).toEqual(
      expect.arrayContaining(["input.consumed", "changeset.proposed", "permission.asked", "permission.replied", "changeset.applied"]),
    );
    const last = (await readEvents(sessionId, 0, 1000)).filter((e) => e.type === "text.ended").pop();
    expect(last).toMatchObject({ text: "Applied and verified." });
    expect(await prisma.graphNode.count({ where: { siteId, name: `${PREFIX}-ok` } })).toBe(1);
    const changeset = await prisma.graphChangeset.findFirstOrThrow({ where: { title: `${PREFIX} applied` } });
    expect(changeset).toMatchObject({ status: "APPLIED", appliedById: adminId, sessionId });
  });

  it("hands a rejection's feedback to the agent and applies nothing", async () => {
    const sessionId = await prompt("BUILD REJECT a node");
    const [request] = (await rpcCall(server, "agent/approval/list", { siteId, sessionId }, adminToken)).json as Array<{ id: string }>;
    await rpcCall(server, "agent/approval/reply", { siteId, requestId: request.id, reply: "reject", feedback: "Use the Press naming scheme" }, adminToken);
    await drainLocalRuns();
    const last = (await readEvents(sessionId, 0, 1000)).filter((e) => e.type === "text.ended").pop();
    expect(last && "text" in last && last.text).toContain("Use the Press naming scheme");
    expect(await prisma.graphNode.count({ where: { siteId, name: `${PREFIX}-rej` } })).toBe(0);
  });

  it("keeps the explore agent read-only", async () => {
    const sessionId = await prompt("PROPOSE something", { agentKey: "explore" });
    const failed = (await readEvents(sessionId, 0, 1000)).find((e) => e.type === "tool.failed");
    expect(failed).toMatchObject({ name: "propose_changeset" });
    expect(await status(sessionId)).toBe("IDLE");
  });

  it("delegates to a subagent in a child session", async () => {
    const sessionId = await prompt("DELEGATE a count");
    const events = await readEvents(sessionId, 0, 1000);
    const started = events.find((e) => e.type === "subagent.started");
    expect(started).toBeTruthy();
    const childId = started && "childSessionId" in started ? started.childSessionId : "";
    const child = await prisma.agentSession.findUniqueOrThrow({ where: { id: childId } });
    expect(child).toMatchObject({ parentSessionId: sessionId, trigger: "AGENT", agentKey: "explore" });
    const last = events.filter((e) => e.type === "text.ended").pop();
    expect(last && "text" in last && last.text).toBe("Subagent said: Explore found 3 nodes.");
  });

  it("keeps chats private and runs public to the site", async () => {
    const sessionId = await prompt("Hello there");
    const asViewer = await rpcCall(server, "agent/session/get", { siteId, id: sessionId }, viewerToken);
    expect(asViewer.statusCode).toBe(404);
    const mine = await rpcCall(server, "agent/session/list", { siteId, scope: "mine" }, adminToken);
    expect((mine.json as Array<{ id: string }>).some((s) => s.id === sessionId)).toBe(true);
  });

  it("lets a chat's owner rename it, and nobody else", async () => {
    const sessionId = await prompt("Hello rename");
    const renamed = await rpcCall(
      server,
      "agent/session/rename",
      { siteId, id: sessionId, title: "  Scrap tracking  " },
      adminToken,
    );
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json).toMatchObject({ id: sessionId, title: "Scrap tracking" });
    const asViewer = await rpcCall(
      server,
      "agent/session/rename",
      { siteId, id: sessionId, title: "Mine now" },
      viewerToken,
    );
    expect(asViewer.statusCode).toBe(404);
  });

  it("starts an agent run when a hook fires, once per event", async () => {
    const definition = await rpcCall(
      server,
      "agent/definition/create",
      { siteId, key: "ar-watch", name: "Watcher", baseKey: "investigator", runAsUserId: adminId },
      adminToken,
    );
    expect(definition.statusCode).toBe(200);
    const trigger = await rpcCall(
      server,
      "agent/trigger/create",
      {
        siteId,
        agentKey: "ar-watch",
        name: `${PREFIX} low value`,
        kind: "HOOK_EVENT",
        prompt: "{{hook}} fired with {{current}}",
        eventNamespace: "livestore",
        eventName: "hook_triggered",
        eventVersion: "1",
      },
      adminToken,
    );
    expect(trigger.statusCode).toBe(200);

    const event = {
      id: randomUUID(),
      namespace: "livestore",
      name: "hook_triggered",
      type: "livestore.hook_triggered",
      version: "1",
      siteId,
      hookId: randomUUID(),
      hookName: "Low value",
      propertyId: randomUUID(),
      emittedAt: new Date().toISOString(),
      previous: 10,
      current: 2,
      payload: {},
      context: {},
    };
    const [sessionId] = await fireHookEvent(event);
    await drainLocalRuns();
    expect(sessionId).toBeTruthy();
    const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session).toMatchObject({ trigger: "HOOK_EVENT", agentKey: "ar-watch", actorUserId: adminId, status: "IDLE" });
    const consumed = (await readEvents(sessionId, 0, 100)).find((e) => e.type === "input.consumed");
    expect(consumed && "text" in consumed && consumed.text).toContain("Low value fired with 2");
    const last = (await readEvents(sessionId, 0, 100)).filter((e) => e.type === "text.ended").pop();
    expect(last && "text" in last && last.text).toBe("Investigated the hook.");

    // A redelivered event starts nothing new.
    expect(await fireHookEvent(event)).toEqual([sessionId]);
    expect(await prisma.agentSession.count({ where: { siteId, triggerRef: { contains: event.id } } })).toBe(1);

    // Site runs are visible to plant members.
    const runs = await rpcCall(server, "agent/session/list", { siteId, scope: "runs" }, viewerToken);
    expect((runs.json as Array<{ id: string }>).some((s) => s.id === sessionId)).toBe(true);
  });

  it("fails a call that was running when its node died, without re-running it", async () => {
    const sessionId = await prompt("Hello again");
    const toolUseId = `toolu_${randomUUID().slice(0, 12)}`;
    await prisma.agentMessage.create({
      data: {
        sessionId,
        seq: 1000,
        role: "ASSISTANT",
        content: [{ type: "tool_use", id: toolUseId, name: "graph_search", input: {} }],
      },
    });
    await prisma.agentSession.update({
      where: { id: sessionId },
      data: { leaseOwner: "dead-node", leaseExpiresAt: new Date(Date.now() - 1000), status: "RUNNING" },
    });
    await runSession(sessionId);
    const failed = (await readEvents(sessionId, 0, 1000)).find((e) => e.type === "tool.failed");
    expect(failed).toMatchObject({ toolUseId, interrupted: true });
    expect(await status(sessionId)).toBe("IDLE");
  });

  // History is replayed to the model on every new prompt and every resume, so
  // it must come back byte for byte: tool inputs are rendered into the prompt,
  // and re-sorted keys (as jsonb stores them) miss the prompt cache.
  it("replays stored history byte for byte", async () => {
    const sessionId = await prompt("Hello cache");
    const message: BetaMessageParam = {
      role: "assistant",
      content: [
        { type: "text", text: "Looking.", citations: null } as never,
        {
          type: "tool_use",
          id: `toolu_${randomUUID().slice(0, 12)}`,
          name: "graph_search",
          input: { query: "press", limit: 5, nodeIds: ["b", "a"], filter: { zeta: 1, alpha: { y: 2, b: 3 } } },
        },
      ],
    };
    await prisma.$transaction((tx) => appendMessage(tx, sessionId, message));
    const replayed = (await history(sessionId)).at(-1);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(message));
  });
});

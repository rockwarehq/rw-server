import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { createRouterClient, type Router } from "@orpc/server";
import type { Current } from "@rw/auth/context";
import prisma from "@rw/db";

import { loadUserCurrent } from "../auth/plugin.js";
import { agentConfig } from "../config.js";
import { moduleLogger } from "../logger.js";
import { type ResolvedAgent, resolveAgent } from "./agents.js";
import { ask, notifyApprovers } from "./approvals.js";
import { subscribe } from "./bus.js";
import { appendEvents, commitEvents, type DurableEvent, publishCommitted, publishLive } from "./events.js";
import { runTurn } from "./loop.js";
import { capForChild, type Ruleset } from "./permission.js";
import { agentSystemPrompt } from "./prompt.js";
import { enqueueRun } from "./queue.js";
import {
  admittedInputs,
  appendMessage,
  createSession,
  admitInput,
  history,
  type InputContextItem,
  pendingToolUses,
  renderUserTurn,
} from "./sessions.js";
import {
  type AppRouterClient,
  decideToolCall,
  executeToolCall,
  serializeOutput,
  type ToolContext,
  toolsFor,
} from "./tools.js";

// Runs a session: claims it (a renewable lease, so one node at a time and a
// dead node's session can be taken over), resolves tool calls that were
// waiting on a person, feeds new inputs to the model, and parks again when a
// call needs approval. Everything it does is in the session's event log.

const log = moduleLogger("agent-runner");
const NODE_ID = `${process.env.FLY_MACHINE_ID ?? "local"}:${process.pid}:${randomUUID().slice(0, 8)}`;
const LEASE_MS = 90_000;
const REPEAT_LIMIT = 3;

let anthropic: Anthropic | null = null;
function client(): Anthropic {
  anthropic ??= new Anthropic({ apiKey: agentConfig.apiKey, maxRetries: 0 });
  return anthropic;
}

/** Tests swap the model client. */
export function setAnthropicClient(next: Anthropic | null): void {
  anthropic = next;
}

export const interruptSubject = (sessionId: string) => `agent.session.${sessionId}.interrupt`;

// Sessions this process is running right now (the lease guards other nodes).
const active = new Set<string>();

async function claim(sessionId: string): Promise<boolean> {
  const now = new Date();
  const claimed = await prisma.agentSession.updateMany({
    where: { id: sessionId, OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now } }] },
    data: { leaseOwner: NODE_ID, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
  });
  return claimed.count === 1;
}

async function renew(sessionId: string): Promise<void> {
  await prisma.agentSession.updateMany({
    where: { id: sessionId, leaseOwner: NODE_ID },
    data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
  });
}

async function release(sessionId: string, status: "IDLE" | "WAITING_APPROVAL" | "FAILED"): Promise<void> {
  await prisma.agentSession.updateMany({
    where: { id: sessionId, leaseOwner: NODE_ID },
    data: { leaseOwner: null, leaseExpiresAt: null, status },
  });
  publishLive(sessionId, { type: "status", status });
}

async function savedRules(siteId: string, agentKey: string): Promise<Ruleset> {
  const rows = await prisma.agentPermissionRule.findMany({
    where: { siteId, OR: [{ agentKey: null }, { agentKey }] },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    permission: row.permission,
    pattern: row.pattern,
    action: row.action as "allow" | "ask" | "deny",
  }));
}

interface RunOptions {
  /** A subagent's rules, capped by its parent's. */
  rulesets?: Ruleset[];
  depth?: number;
}

interface RunContext {
  session: NonNullable<Awaited<ReturnType<typeof loadSession>>>;
  agent: ResolvedAgent;
  rulesets: Ruleset[];
  current: Current;
  routerClient: AppRouterClient;
  abort: AbortController;
  depth: number;
}

function loadSession(sessionId: string) {
  return prisma.agentSession.findUnique({
    where: { id: sessionId },
    include: { site: { select: { workspaceId: true } } },
  });
}

async function routerFor(current: Current): Promise<AppRouterClient> {
  // Imported here: the router imports this module through rpc/agent.ts.
  const { router } = await import("../rpc/index.js");
  return createRouterClient(
    router as Router<never, never>,
    {
      context: { request: { headers: {} }, current, access: current.access },
    } as never,
  ) as unknown as AppRouterClient;
}

function toolContext(run: RunContext, toolUseId: string, approval: ToolContext["approval"]): ToolContext {
  return {
    client: run.routerClient,
    siteId: run.session.siteId,
    workspaceId: run.session.site.workspaceId,
    sessionId: run.session.id,
    toolUseId,
    userId: run.current.kind === "user" ? run.current.user.id : null,
    agent: run.agent,
    abort: run.abort.signal,
    approval,
    requireSiteAdmin: async () => {
      await run.current.access.require("ADMIN", { site: run.session.siteId });
    },
    runSubagent: run.depth === 0 ? (agentKey, prompt) => runSubagent(run, toolUseId, agentKey, prompt) : null,
  };
}

/** Run an allowed or approved call and record its outcome. */
async function execute(
  run: RunContext,
  call: { id: string; name: string; input: unknown },
  approval: ToolContext["approval"],
): Promise<BetaToolResultBlockParam> {
  const decision = decideToolCall(call.name, call.input, run.rulesets);
  if (decision.kind === "unknown" || decision.kind === "invalid" || decision.kind === "deny") {
    await commitEvents(run.session.id, [
      { type: "tool.failed", toolUseId: call.id, name: call.name, error: decision.error },
    ]);
    return { type: "tool_result", tool_use_id: call.id, is_error: true, content: decision.error };
  }
  try {
    const result = await executeToolCall(decision.tool, decision.input, toolContext(run, call.id, approval));
    const serialized = serializeOutput(result.output, call.id);
    await commitEvents(run.session.id, [
      {
        type: "tool.completed",
        toolUseId: call.id,
        name: call.name,
        output: serialized.stored,
        truncated: serialized.truncated,
        metadata: result.metadata,
      },
      ...(result.events ?? []),
    ]);
    return { type: "tool_result", tool_use_id: call.id, content: serialized.model };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await commitEvents(run.session.id, [{ type: "tool.failed", toolUseId: call.id, name: call.name, error }]);
    return { type: "tool_result", tool_use_id: call.id, is_error: true, content: error };
  }
}

const signature = (call: { name: string; input: unknown }) => `${call.name}:${JSON.stringify(call.input ?? {})}`;

/** The calls of one assistant turn: run, refuse, or park each. */
async function handleCalls(run: RunContext, calls: BetaToolUseBlock[], recent: string[]) {
  const results: Array<BetaToolResultBlockParam | null> = [];
  let parked = false;
  // Reads run concurrently; asks are recorded as they come.
  await Promise.all(
    calls.map(async (call, index) => {
      const decision = decideToolCall(call.name, call.input, run.rulesets);
      recent.push(signature(call));
      const repeated = recent.length >= REPEAT_LIMIT && recent.slice(-REPEAT_LIMIT).every((s) => s === signature(call));
      if (decision.kind === "ask" || (decision.kind === "allow" && repeated)) {
        if (run.depth > 0) {
          results[index] = await execute(run, call, null);
          return;
        }
        const permission = decision.kind === "ask" ? decision.permission : "doom_loop";
        const patterns = decision.kind === "ask" ? decision.patterns : [call.name];
        const askInput = {
          sessionId: run.session.id,
          siteId: run.session.siteId,
          trigger: run.session.trigger,
          agent: run.agent,
          toolUseId: call.id,
          toolName: call.name,
          toolInput: call.input,
          permission,
          patterns,
        };
        const { requestId } = await prisma.$transaction((tx) => ask(askInput, tx));
        publishCommitted(run.session.id);
        await notifyApprovers(askInput, requestId);
        results[index] = null;
        parked = true;
        return;
      }
      results[index] = await execute(run, call, null);
    }),
  );
  return parked ? ("parked" as const) : (results as BetaToolResultBlockParam[]);
}

/** Calls left waiting when the run parked or crashed, answered where possible. */
async function resolvePending(
  run: RunContext,
  pending: Array<{ id: string; name: string; input: unknown }>,
): Promise<{ results: BetaToolResultBlockParam[]; waiting: boolean; interrupted: boolean }> {
  const events = await prisma.agentEvent.findMany({
    where: {
      sessionId: run.session.id,
      OR: [{ type: { startsWith: "tool.completed." } }, { type: { startsWith: "tool.failed." } }],
    },
    orderBy: { seq: "desc" },
    take: 200,
  });
  const outcome = new Map<string, { type: string; payload: Record<string, unknown> }>();
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    const id = String(payload.toolUseId);
    if (!outcome.has(id)) outcome.set(id, { type: event.type, payload });
  }
  const requests = await prisma.agentPermissionRequest.findMany({
    where: { sessionId: run.session.id, toolUseId: { in: pending.map((call) => call.id) } },
  });
  const requestFor = new Map(requests.map((request) => [request.toolUseId, request]));

  const results: BetaToolResultBlockParam[] = [];
  let waiting = false;
  let interrupted = false;
  for (const call of pending) {
    const done = outcome.get(call.id);
    if (done) {
      if (done.type.startsWith("tool.completed.")) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: serializeOutput(String(done.payload.output ?? ""), call.id).model,
        });
      } else {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: String(done.payload.error),
        });
      }
      continue;
    }
    const request = requestFor.get(call.id);
    if (request?.status === "PENDING") {
      waiting = true;
      continue;
    }
    if (request?.status === "APPROVED") {
      results.push(await execute(run, call, { repliedById: request.repliedById ?? run.session.actorUserId }));
      continue;
    }
    if (request?.status === "REJECTED" || request?.status === "EXPIRED") {
      const content =
        request.status === "EXPIRED"
          ? "Nobody answered this approval request in time; it expired. Don't retry it unless asked."
          : request.feedback
            ? `The engineer rejected this, with feedback: ${request.feedback}`
            : "The engineer rejected this.";
      await commitEvents(run.session.id, [
        { type: "tool.failed", toolUseId: call.id, name: call.name, error: content },
      ]);
      results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content });
      continue;
    }
    // Called but never finished: the run stopped mid-call. Fail it closed;
    // side effects are never replayed.
    const content = "This tool call was interrupted before it finished. It may or may not have taken effect.";
    await commitEvents(run.session.id, [
      { type: "tool.failed", toolUseId: call.id, name: call.name, error: content, interrupted: true },
    ]);
    results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content });
    interrupted = true;
  }
  return { results, waiting, interrupted };
}

async function commitMessages(
  sessionId: string,
  events: DurableEvent[],
  messages: Array<{
    message: BetaMessageParam;
    usage?: NonNullable<Parameters<typeof appendMessage>[3]>["usage"];
    model?: string;
  }> = [],
) {
  await prisma.$transaction(async (tx) => {
    for (const entry of messages) await appendMessage(tx, sessionId, entry.message, entry);
    await appendEvents(tx, sessionId, events);
  });
  publishCommitted(sessionId);
}

/** Model calls this request has used: steps since the last consumed input. */
async function stepsUsed(sessionId: string): Promise<number> {
  const lastInput = await prisma.agentEvent.findFirst({
    where: { sessionId, type: { startsWith: "input.consumed." } },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return prisma.agentEvent.count({
    where: { sessionId, seq: { gt: lastInput?.seq ?? 0 }, type: { startsWith: "step.finished." } },
  });
}

/** The session's last model response id: where cache diagnosis compares from. */
async function lastMessageId(sessionId: string): Promise<string | null> {
  const step = await prisma.agentEvent.findFirst({
    where: { sessionId, type: { startsWith: "step.finished." } },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  const id = (step?.payload as { messageId?: unknown } | null)?.messageId;
  return typeof id === "string" ? id : null;
}

/**
 * Make all the progress a session can make right now. Safe to call at any
 * time and from any node: without the lease it does nothing.
 */
export async function runSession(sessionId: string, options: RunOptions = {}): Promise<void> {
  if (active.has(sessionId)) return;
  active.add(sessionId);
  if (!(await claim(sessionId))) {
    active.delete(sessionId);
    return;
  }
  const abort = new AbortController();
  const renewal = setInterval(() => void renew(sessionId), LEASE_MS / 3);
  const unsubscribe = await subscribe(interruptSubject(sessionId), () => abort.abort());
  let finalStatus: "IDLE" | "WAITING_APPROVAL" | "FAILED" = "IDLE";

  try {
    const session = await loadSession(sessionId);
    if (!session) return;
    await prisma.agentSession.update({ where: { id: sessionId }, data: { status: "RUNNING" } });
    publishLive(sessionId, { type: "status", status: "RUNNING" });

    const agent = await resolveAgent(session.siteId, session.agentKey);
    const current = await loadUserCurrent(session.actorUserId, session.site.workspaceId, session.siteId);
    if (!agent?.enabled || !current) {
      await commitEvents(sessionId, [
        {
          type: "error",
          message: !agent?.enabled
            ? `The agent "${session.agentKey}" is missing or disabled.`
            : "The person this agent acts as no longer has access to this site.",
        },
      ]);
      finalStatus = "FAILED";
      return;
    }
    const rulesets = options.rulesets ?? [...agent.rulesets, await savedRules(session.siteId, agent.key)];
    const run: RunContext = {
      session,
      agent,
      rulesets,
      current,
      routerClient: await routerFor(current),
      abort,
      depth: options.depth ?? 0,
    };

    // Keep going while there's something to do: answered approvals, then
    // new inputs (queued while the model worked).
    while (!abort.signal.aborted) {
      let messages = await history(sessionId);
      const pending = pendingToolUses(messages);
      let resumed = false;
      if (pending.length > 0) {
        const resolved = await resolvePending(run, pending);
        if (resolved.waiting) {
          finalStatus = "WAITING_APPROVAL";
          return;
        }
        const resultMessage: BetaMessageParam = { role: "user", content: resolved.results };
        await commitMessages(sessionId, [], [{ message: resultMessage }]);
        messages = [...messages, resultMessage];
        resumed = !resolved.interrupted;
      }

      const inputs = await admittedInputs(sessionId);
      if (inputs.length > 0) {
        const userMessage: BetaMessageParam = {
          role: "user",
          content: inputs.map((input) => ({
            type: "text" as const,
            text: renderUserTurn(input.text, input.context as unknown as InputContextItem[]),
          })),
        };
        await prisma.$transaction(async (tx) => {
          await tx.agentInput.updateMany({
            where: { id: { in: inputs.map((input) => input.id) } },
            data: { status: "CONSUMED" },
          });
          await appendMessage(tx, sessionId, userMessage);
          await appendEvents(
            tx,
            sessionId,
            inputs.map((input) => ({
              type: "input.consumed" as const,
              inputId: input.id,
              text: input.text,
              context: ((input.context as unknown as InputContextItem[]) ?? []).map(({ kind, label }) => ({
                kind,
                label,
              })),
            })),
          );
        });
        publishCommitted(sessionId);
        messages = [...messages, userMessage];
      } else if (!resumed) {
        return;
      }

      await commitEvents(sessionId, [{ type: "turn.started", agentKey: agent.key }]);
      const recent: string[] = [];
      const outcome = await runTurn({
        anthropic: client(),
        model: agent.model,
        effort: agent.effort,
        system: agentSystemPrompt(agent),
        tools: toolsFor(rulesets),
        history: messages,
        stepsLeft: Math.max(1, agent.maxSteps - (await stepsUsed(sessionId))),
        signal: abort.signal,
        emitLive: (event) => publishLive(sessionId, event),
        commit: (events, entries) => commitMessages(sessionId, events, entries),
        handleToolCalls: (calls) => handleCalls(run, calls, recent),
        ...(agentConfig.cacheDiagnostics
          ? { cacheDiagnostics: { previousMessageId: await lastMessageId(sessionId) } }
          : {}),
      });
      if (outcome === "parked") {
        finalStatus = "WAITING_APPROVAL";
        return;
      }
      await commitEvents(sessionId, [{ type: "turn.finished", stopReason: outcome }]);
      if (outcome === "error" || outcome === "refusal") {
        finalStatus = session.trigger === "CHAT" ? "IDLE" : "FAILED";
        return;
      }
    }
    if (abort.signal.aborted) await commitEvents(sessionId, [{ type: "turn.finished", stopReason: "aborted" }]);
  } catch (err) {
    log.error({ err, sessionId }, "agent run failed");
    await commitEvents(sessionId, [
      { type: "error", message: err instanceof Error ? err.message : "The agent run failed" },
    ]).catch(() => {});
    finalStatus = "FAILED";
  } finally {
    clearInterval(renewal);
    unsubscribe();
    await release(sessionId, finalStatus);
    active.delete(sessionId);
    // An input admitted after the last check would otherwise wait for the
    // next wake.
    if (finalStatus !== "WAITING_APPROVAL" && !abort.signal.aborted) {
      const late = await prisma.agentInput.count({ where: { sessionId, status: "ADMITTED" } });
      if (late > 0) await enqueueRun(sessionId, "late-input");
    }
  }
}

async function runSubagent(
  parent: RunContext,
  toolUseId: string,
  agentKey: string,
  prompt: string,
): Promise<{ childSessionId: string; text: string }> {
  const agent = await resolveAgent(parent.session.siteId, agentKey);
  if (!agent?.subagent) throw new Error(`"${agentKey}" can't be used as a subagent`);
  const { session: child } = await createSession({
    siteId: parent.session.siteId,
    agentKey,
    agentVersion: agent.version,
    actorUserId: parent.session.actorUserId,
    title: prompt.split("\n")[0] ?? agent.name,
    trigger: "AGENT",
    triggerRef: `${parent.session.id}:${toolUseId}`,
    parentSessionId: parent.session.id,
  });
  await admitInput(child.id, { id: randomUUID(), text: prompt });
  await commitEvents(parent.session.id, [{ type: "subagent.started", childSessionId: child.id, agentKey, toolUseId }]);
  await runSession(child.id, { rulesets: capForChild(parent.rulesets, agent.rulesets), depth: parent.depth + 1 });
  const done = await prisma.agentSession.findUniqueOrThrow({ where: { id: child.id }, select: { status: true } });
  await commitEvents(parent.session.id, [{ type: "subagent.finished", childSessionId: child.id, status: done.status }]);
  const last = await prisma.agentEvent.findFirst({
    where: { sessionId: child.id, type: { startsWith: "text.ended." } },
    orderBy: { seq: "desc" },
  });
  const text = (last?.payload as { text?: string } | undefined)?.text;
  if (!text) throw new Error(`The ${agent.name} subagent finished without an answer`);
  return { childSessionId: child.id, text };
}

/** Sessions whose node died mid-run: take them over so they finish cleanly. */
export async function recoverSessions(): Promise<void> {
  const stale = await prisma.agentSession.findMany({
    where: { leaseOwner: { not: null }, leaseExpiresAt: { lt: new Date() } },
    select: { id: true },
    take: 200,
  });
  for (const session of stale) await enqueueRun(session.id, "recover");
  if (stale.length) log.info({ count: stale.length }, "recovering agent sessions");
}

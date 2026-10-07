import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { builtInAgent } from "../src/agent/agents.js";
import type { DurableEvent } from "../src/agent/events.js";
import { buildToolDefinitions, retryDelay, runTurn, STEP_LIMIT_NOTE, type TurnHost } from "../src/agent/loop.js";
import { capForChild, evaluate, evaluateAll, isHidden, wildcardMatch } from "../src/agent/permission.js";
import { renderUserTurn } from "../src/agent/sessions.js";
import { AGENT_TOOLS, type AgentTool, decideToolCall, serializeOutput, toolsFor } from "../src/agent/tools.js";
import { renderPrompt, stableUuid } from "../src/agent/triggers.js";

type Scripted = Partial<BetaMessage> | ((params: { messages: BetaMessageParam[]; tool_choice?: unknown }) => Partial<BetaMessage> | Error);

// A scripted stand-in for client.beta.messages.stream: each call plays the
// next entry (a message, or an error to throw).
export function fakeAnthropic(script: Scripted[]) {
  const calls: Array<{ messages: BetaMessageParam[]; tool_choice?: unknown; tools?: unknown[] }> = [];
  const stream = vi.fn((params: { messages: BetaMessageParam[]; tool_choice?: unknown; tools?: unknown[] }) => {
    calls.push(structuredClone(params));
    const entry = script.shift();
    if (!entry) throw new Error("script exhausted");
    const next = typeof entry === "function" ? entry(params) : entry;
    if (next instanceof Error) {
      return {
        [Symbol.asyncIterator]: async function* () {
          throw next;
        },
        finalMessage: async () => {
          throw next;
        },
      };
    }
    const message = {
      id: "msg",
      model: "claude-opus-5",
      role: "assistant",
      type: "message",
      usage: { input_tokens: 10, output_tokens: 5 },
      ...next,
    } as BetaMessage;
    return {
      async *[Symbol.asyncIterator]() {
        for (const block of message.content) {
          if (block.type === "text") {
            yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } };
          }
        }
      },
      finalMessage: async () => message,
    };
  });
  return { anthropic: { beta: { messages: { stream } } } as unknown as Anthropic, calls };
}

const toolUse = (id: string, name: string, input: unknown) =>
  ({ type: "tool_use", id, name, input }) as BetaMessage["content"][number];
const text = (value: string) => ({ type: "text", text: value, citations: null }) as BetaMessage["content"][number];

function host(anthropic: Anthropic, overrides: Partial<TurnHost> = {}) {
  const committed: DurableEvent[] = [];
  const messages: BetaMessageParam[] = [];
  const live: string[] = [];
  const turnHost: TurnHost = {
    anthropic,
    model: "claude-opus-5",
    effort: "high",
    system: "sys",
    tools: [] as AgentTool[],
    history: [{ role: "user", content: "hi" }],
    stepsLeft: 10,
    signal: new AbortController().signal,
    emitLive: (event) => live.push(event.type),
    commit: async (events, entries = []) => {
      committed.push(...events);
      messages.push(...entries.map((entry) => entry.message));
    },
    handleToolCalls: async (calls) => calls.map((call) => ({ type: "tool_result", tool_use_id: call.id, content: "ok" })),
    sleep: async () => {},
    ...overrides,
  };
  return { turnHost, committed, messages, live };
}

describe("runTurn", () => {
  it("records each tool call before running it, then the results, then the answer", async () => {
    const { anthropic, calls } = fakeAnthropic([
      { stop_reason: "tool_use", content: [toolUse("t1", "graph_search", {}), toolUse("t2", "graph_search", {})] },
      { stop_reason: "end_turn", content: [text("done")] },
    ]);
    const order: string[] = [];
    const { turnHost, committed, messages, live } = host(anthropic, {
      handleToolCalls: async (blocks) => {
        order.push(`run:${committed.filter((e) => e.type === "tool.called").length}`);
        return blocks.map((call) => ({ type: "tool_result", tool_use_id: call.id, content: "ok" }));
      },
    });

    expect(await runTurn(turnHost)).toBe("end_turn");
    expect(order).toEqual(["run:2"]);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(committed.map((e) => e.type)).toEqual([
      "step.finished",
      "tool.called",
      "tool.called",
      "text.ended",
      "step.finished",
    ]);
    expect(live).toContain("text.delta");
    expect(calls[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("parks when a call waits for a person", async () => {
    const { anthropic } = fakeAnthropic([
      { stop_reason: "tool_use", content: [toolUse("t1", "apply_changeset", { changesetId: "x" })] },
    ]);
    const { turnHost, messages } = host(anthropic, { handleToolCalls: async () => "parked" });
    expect(await runTurn(turnHost)).toBe("parked");
    expect(messages.map((m) => m.role)).toEqual(["assistant"]);
  });

  it("never runs tools from a turn cut off at max_tokens", async () => {
    const handleToolCalls = vi.fn();
    const { anthropic } = fakeAnthropic([{ stop_reason: "max_tokens", content: [toolUse("t1", "graph_search", {})] }]);
    const { turnHost } = host(anthropic, { handleToolCalls });
    expect(await runTurn(turnHost)).toBe("max_tokens");
    expect(handleToolCalls).not.toHaveBeenCalled();
  });

  it("spends its last step with tools off, telling the model why", async () => {
    const { anthropic, calls } = fakeAnthropic([
      { stop_reason: "tool_use", content: [toolUse("t1", "graph_search", {})] },
      { stop_reason: "end_turn", content: [text("summary")] },
    ]);
    const tool = { name: "graph_search", description: "d", input: z.object({}), permission: { key: "graph.read" } } as unknown as AgentTool;
    const { turnHost } = host(anthropic, { stepsLeft: 2, tools: [tool] });
    expect(await runTurn(turnHost)).toBe("max_steps");
    expect(calls[0].tool_choice).toEqual({ type: "auto" });
    expect(calls[1].tool_choice).toEqual({ type: "none" });
    const last = calls[1].messages[calls[1].messages.length - 1];
    expect(JSON.stringify(last.content)).toContain(STEP_LIMIT_NOTE.slice(0, 40));
  });

  it("asks why each request missed the cache, comparing with the response before it", async () => {
    const miss = { type: "messages_changed", cache_missed_input_tokens: 4200 };
    const { anthropic, calls } = fakeAnthropic([
      { id: "msg_1", stop_reason: "tool_use", content: [toolUse("t1", "graph_search", {})], diagnostics: { cache_miss_reason: miss } } as Partial<BetaMessage>,
      { id: "msg_2", stop_reason: "end_turn", content: [text("done")], diagnostics: { cache_miss_reason: null } } as Partial<BetaMessage>,
    ]);
    const { turnHost, committed } = host(anthropic, { cacheDiagnostics: { previousMessageId: "msg_0" } });
    expect(await runTurn(turnHost)).toBe("end_turn");

    const sent = calls as unknown as Array<{ betas: string[]; diagnostics: { previous_message_id: string | null } }>;
    expect(sent[0].betas).toContain("cache-diagnosis-2026-04-07");
    expect(sent.map((call) => call.diagnostics.previous_message_id)).toEqual(["msg_0", "msg_1"]);
    const steps = committed.filter((event) => event.type === "step.finished");
    expect(steps[0]).toMatchObject({ messageId: "msg_1", cacheMiss: miss });
    expect(steps[1]).toMatchObject({ messageId: "msg_2" });
    expect(steps[1]).not.toHaveProperty("cacheMiss");
  });

  it("leaves cache diagnostics off unless asked", async () => {
    const { anthropic, calls } = fakeAnthropic([{ stop_reason: "end_turn", content: [text("ok")] }]);
    const { turnHost } = host(anthropic);
    await runTurn(turnHost);
    const sent = calls[0] as unknown as { betas: string[]; diagnostics?: unknown };
    expect(sent.betas).not.toContain("cache-diagnosis-2026-04-07");
    expect(sent).not.toHaveProperty("diagnostics");
  });

  it("retries an overloaded model and records the retry", async () => {
    const overloaded = new Anthropic.APIError(529, { type: "overloaded_error" }, "Overloaded", new Headers());
    const { anthropic } = fakeAnthropic([() => overloaded, { stop_reason: "end_turn", content: [text("ok")] }]);
    const { turnHost, committed } = host(anthropic);
    expect(await runTurn(turnHost)).toBe("end_turn");
    expect(committed[0]).toMatchObject({ type: "retry", attempt: 1 });
  });

  it("gives up on a bad request without retrying", async () => {
    const bad = new Anthropic.BadRequestError(400, { type: "invalid_request_error" }, "bad", new Headers());
    const { anthropic } = fakeAnthropic([() => bad]);
    const { turnHost, committed } = host(anthropic);
    expect(await runTurn(turnHost)).toBe("error");
    expect(committed.map((e) => e.type)).toEqual(["error"]);
  });
});

describe("retryDelay", () => {
  it("honors retry-after and refuses client errors", () => {
    const limited = new Anthropic.RateLimitError(429, {}, "slow down", new Headers({ "retry-after": "3" }));
    expect(retryDelay(limited, 0)).toBe(3000);
    expect(retryDelay(new Anthropic.BadRequestError(400, {}, "no", new Headers()), 0)).toBeNull();
    expect(retryDelay(new Error("boom"), 0)).toBeNull();
  });
});

describe("permissions", () => {
  it("lets the last matching rule win and defaults to ask", () => {
    const rules = [
      { permission: "*", pattern: "*", action: "deny" as const },
      { permission: "graph.*", pattern: "*", action: "allow" as const },
      { permission: "graph.read", pattern: "secret-*", action: "ask" as const },
    ];
    expect(evaluate([rules], "graph.read", "nodes")).toBe("allow");
    expect(evaluate([rules], "graph.read", "secret-x")).toBe("ask");
    expect(evaluate([rules], "devices.read", "x")).toBe("deny");
    expect(evaluate([], "anything", "x")).toBe("ask");
    expect(evaluateAll([rules], "graph.read", ["nodes", "secret-x"])).toBe("ask");
    expect(wildcardMatch("a*c", "abbc")).toBe(true);
    expect(wildcardMatch("a.c", "abc")).toBe(false);
  });

  it("hides tools an agent may never use", () => {
    const explore = builtInAgent("explore");
    const build = builtInAgent("build");
    const names = (rulesets: Parameters<typeof toolsFor>[0]) => toolsFor(rulesets).map((tool) => tool.name);
    expect(names(explore?.rulesets ?? [])).not.toContain("propose_changeset");
    expect(names(explore?.rulesets ?? [])).not.toContain("task");
    expect(names(build?.rulesets ?? [])).toContain("propose_changeset");
    expect(names(build?.rulesets ?? [])).toContain("apply_changeset");
    expect(isHidden(build?.rulesets ?? [], "agent.task")).toBe(false);
  });

  it("caps a subagent by its parent and turns its asks into denies", () => {
    const parent = [[{ permission: "graph.read", pattern: "*", action: "deny" as const }]];
    const child = [[{ permission: "graph.read", pattern: "*", action: "allow" as const }, { permission: "doom_loop", pattern: "*", action: "ask" as const }]];
    const capped = capForChild(parent, child);
    expect(evaluate(capped, "graph.read", "x")).toBe("deny");
    expect(evaluate(capped, "doom_loop", "x")).toBe("deny");
  });
});

describe("tool decisions", () => {
  const build = builtInAgent("build")?.rulesets ?? [];
  const explore = builtInAgent("explore")?.rulesets ?? [];

  it("validates input with a message the model can act on", () => {
    const decision = decideToolCall("graph_values", { propertyIds: "nope" }, build);
    expect(decision.kind).toBe("invalid");
    expect(decision.kind === "invalid" && decision.error).toMatch(/Rewrite the input/);
  });

  it("always asks before applying a changeset, even when a rule allows it", () => {
    const allowAll = [...build, [{ permission: "changeset.apply", pattern: "*", action: "allow" as const }]];
    const decision = decideToolCall("apply_changeset", { changesetId: "11111111-1111-4111-8111-111111111111" }, allowAll);
    expect(decision.kind).toBe("ask");
  });

  it("treats tools hidden from an agent as unknown", () => {
    expect(decideToolCall("propose_changeset", { title: "x" }, explore).kind).toBe("unknown");
    expect(decideToolCall("graph_search", {}, explore).kind).toBe("allow");
  });

  it("every tool has an object input schema the API accepts", () => {
    const names = new Set<string>();
    for (const definition of buildToolDefinitions(AGENT_TOOLS)) {
      const tool = definition as { name: string; input_schema: { type: string } };
      expect(tool.name).toMatch(/^[a-z_]{1,64}$/);
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      expect(tool.input_schema.type).toBe("object");
    }
  });

  it("truncates large output with a way to read the rest", () => {
    const big = "x".repeat(70_000);
    const out = serializeOutput(big, "t9");
    expect(out.truncated).toBe(true);
    expect(out.stored.length).toBe(70_000);
    expect(out.model).toContain('tool_output_read({ toolUseId: "t9"');
  });
});

describe("prompts", () => {
  it("fills trigger templates from the event", () => {
    expect(renderPrompt("Hook {{hook}} saw {{current}} on {{payload.station}}", {
      hook: "low OEE",
      current: 0.42,
      payload: { station: "Press 4" },
    })).toBe("Hook low OEE saw 0.42 on Press 4");
    expect(stableUuid("a", "b")).toBe(stableUuid("a", "b"));
    expect(stableUuid("a", "b")).not.toBe(stableUuid("a", "c"));
  });

  it("wraps editor context and escapes it", () => {
    const rendered = renderUserTurn("why is this bad?", [
      { kind: "property", id: "p1", label: "OEE <calc>", detail: "expr: p_a & p_b" },
    ]);
    expect(rendered).toContain('<item kind="property" id="p1" label="OEE &lt;calc&gt;">');
    expect(rendered).toContain("expr: p_a &amp; p_b");
    expect(renderUserTurn("hello")).toBe("hello");
  });
});

import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaToolUseBlock,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { AgentUsage, DurableEvent, LiveEvent } from "./events.js";
import { type AgentTool, toolInputJsonSchema } from "./tools.js";

// One stretch of an agent run: stream the model, hand its tool calls to the
// host, repeat until it answers, its step budget is spent, or a tool call
// needs a person (the run parks and resumes later). The host (runner.ts)
// owns persistence, permissions and tool execution; this file only talks to
// the model.

export interface TurnHost {
  anthropic: Anthropic;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  system: string;
  tools: readonly AgentTool[];
  history: BetaMessageParam[];
  /** Model calls left for this input. The last one runs without tools. */
  stepsLeft: number;
  signal: AbortSignal;
  emitLive: (event: LiveEvent) => void;
  /** Persist durable events and model-history messages atomically. */
  commit: (
    events: DurableEvent[],
    messages?: Array<{ message: BetaMessageParam; usage?: AgentUsage; model?: string }>,
  ) => Promise<void>;
  /**
   * Run (or park) the calls of one assistant turn. Returns every result in
   * call order, or "parked" when at least one waits for a person.
   */
  handleToolCalls: (calls: BetaToolUseBlock[]) => Promise<BetaToolResultBlockParam[] | "parked">;
  /** Waits between retries; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Ask the API why each request missed the prompt cache, comparing against
   * this session's previous response (null before its first).
   */
  cacheDiagnostics?: { previousMessageId: string | null };
}

export type TurnOutcome = "end_turn" | "parked" | "aborted" | "refusal" | "max_tokens" | "error" | "max_steps";

const MAX_TOKENS = 64_000;
const MAX_RETRIES = 5;
const MAX_JSON_RETRIES = 2;

export const STEP_LIMIT_NOTE =
  "You've reached the step limit for this request, so you can't call tools in this reply. Summarize what you found and did, what is still open, and what the engineer should do next.";

export function toUsage(usage: BetaUsage): AgentUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

export function buildToolDefinitions(tools: readonly AgentTool[]): BetaToolUnion[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: toolInputJsonSchema(tool) as BetaToolUnion extends { input_schema: infer S } ? S : never,
    eager_input_streaming: true,
  }));
}

/** Overloads, rate limits, 5xx and dropped connections are worth retrying. */
export function retryDelay(error: unknown, attempt: number): number | null {
  if (error instanceof Anthropic.APIConnectionError) return backoff(attempt);
  if (!(error instanceof Anthropic.APIError)) return null;
  const status = error.status ?? 0;
  if (status !== 408 && status !== 409 && status !== 429 && status < 500) return null;
  const ms = Number(error.headers?.get?.("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const seconds = Number(error.headers?.get?.("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return backoff(attempt);
}

function backoff(attempt: number): number {
  return Math.min(60_000, 2000 * 2 ** attempt + Math.random() * 1000);
}

// With the budget spent, the request must not offer tools, but the model
// needs a reason; the note rides along in the last user turn for this
// request only.
function withStepLimitNote(messages: BetaMessageParam[]): BetaMessageParam[] {
  const last = messages[messages.length - 1];
  if (last?.role !== "user") return messages;
  const content: BetaContentBlockParam[] =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  return [...messages.slice(0, -1), { role: "user", content: [...content, { type: "text", text: STEP_LIMIT_NOTE }] }];
}

export async function runTurn(host: TurnHost): Promise<TurnOutcome> {
  const definitions = buildToolDefinitions(host.tools);
  const messages = [...host.history];
  const sleep = host.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let stepsLeft = host.stepsLeft;
  let previousMessageId = host.cacheDiagnostics?.previousMessageId ?? null;

  while (true) {
    if (host.signal.aborted) return "aborted";
    const finalStep = stepsLeft <= 1;
    stepsLeft--;

    let message: BetaMessage | null = null;
    let jsonRetries = 0;
    for (let attempt = 0; message === null; attempt++) {
      const stream = host.anthropic.beta.messages.stream(
        {
          model: host.model,
          max_tokens: MAX_TOKENS,
          betas: host.cacheDiagnostics
            ? ["server-side-fallback-2026-07-01", "cache-diagnosis-2026-04-07"]
            : ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          ...(host.cacheDiagnostics ? { diagnostics: { previous_message_id: previousMessageId } } : {}),
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: host.effort },
          // Tools and system are stable per agent and render first, so they
          // cache; the top-level breakpoint caches the growing history.
          cache_control: { type: "ephemeral" },
          system: [{ type: "text", text: host.system, cache_control: { type: "ephemeral" } }],
          // History holds tool calls, so the definitions stay; the last step
          // just may not use them.
          messages: finalStep ? withStepLimitNote(messages) : messages,
          ...(definitions.length
            ? { tools: definitions, tool_choice: finalStep ? { type: "none" as const } : { type: "auto" as const } }
            : {}),
        },
        { signal: host.signal, maxRetries: 0 },
      );
      try {
        for await (const event of stream) {
          if (event.type !== "content_block_delta") continue;
          if (event.delta.type === "text_delta") host.emitLive({ type: "text.delta", text: event.delta.text });
          else if (event.delta.type === "thinking_delta")
            host.emitLive({ type: "thinking.delta", text: event.delta.thinking });
        }
        message = await stream.finalMessage();
      } catch (error) {
        if (host.signal.aborted) return "aborted";
        const delay = retryDelay(error, attempt);
        if (delay !== null && attempt < MAX_RETRIES) {
          await host.commit([
            {
              type: "retry",
              attempt: attempt + 1,
              nextAt: new Date(Date.now() + delay).toISOString(),
              message: error instanceof Error ? error.message : String(error),
            },
          ]);
          await sleep(delay);
          continue;
        }
        // Unparseable streamed tool input: re-issue the request.
        if (!(error instanceof Anthropic.APIError) && jsonRetries++ < MAX_JSON_RETRIES) continue;
        await host.commit([{ type: "error", message: error instanceof Error ? error.message : String(error) }]);
        return "error";
      }
    }

    const usage = toUsage(message.usage);
    const assistant: BetaMessageParam = { role: "assistant", content: message.content as BetaContentBlockParam[] };
    const events: DurableEvent[] = [];
    for (const block of message.content) {
      if (block.type === "thinking" && block.thinking) events.push({ type: "thinking.ended", text: block.thinking });
      if (block.type === "text" && block.text) events.push({ type: "text.ended", text: block.text });
    }
    events.push({
      type: "step.finished",
      usage,
      model: message.model,
      messageId: message.id,
      ...(message.diagnostics?.cache_miss_reason ? { cacheMiss: message.diagnostics.cache_miss_reason } : {}),
    });
    previousMessageId = message.id;

    if (message.stop_reason === "refusal") {
      await host.commit(
        [...events, { type: "error", message: "The model declined this request." }],
        [{ message: assistant, usage, model: message.model }],
      );
      return "refusal";
    }

    if (message.stop_reason === "pause_turn") {
      messages.push(assistant);
      await host.commit(events, [{ message: assistant, usage, model: message.model }]);
      stepsLeft++;
      continue;
    }

    const calls = message.content.filter((block): block is BetaToolUseBlock => block.type === "tool_use");
    if (calls.length === 0) {
      await host.commit(events, [{ message: assistant, usage, model: message.model }]);
      return finalStep && host.stepsLeft > 1 ? "max_steps" : "end_turn";
    }

    // A tool input cut off at max_tokens parses as a plausible partial
    // object; never run it.
    if (message.stop_reason === "max_tokens") {
      await host.commit(
        [...events, { type: "error", message: "The response was cut off before a tool call finished." }],
        [{ message: assistant, usage, model: message.model }],
      );
      return "max_tokens";
    }

    // Each call is on record before it runs; a crash fails it closed.
    messages.push(assistant);
    await host.commit(
      [
        ...events,
        ...calls.map((call) => ({
          type: "tool.called" as const,
          toolUseId: call.id,
          name: call.name,
          input: call.input,
        })),
      ],
      [{ message: assistant, usage, model: message.model }],
    );

    const results = await host.handleToolCalls(calls);
    if (results === "parked") return "parked";
    const resultMessage: BetaMessageParam = { role: "user", content: results };
    messages.push(resultMessage);
    await host.commit([], [{ message: resultMessage }]);
  }
}

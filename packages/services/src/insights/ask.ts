import prisma from "@rw/db";
import type { ModelMessage, StreamChunk, UIMessage } from "@tanstack/ai";
import type { ReportScope } from "../reporting/types.js";
import { type Board, emptyBoard, parseBoard } from "./board.js";
import { stableInstructions, turnInstructions } from "./prompt.js";
import { insightsTools } from "./tools.js";

// One question in, a stream of events out: the AI's words, its tool calls,
// and a board event each time it changes the board. The page sends the whole
// chat each time; nothing is stored on the server.

/**
 * Which AI runs Insights. The tools, instructions and board are the same for
 * every provider; only the adapter and its settings change.
 *
 * The API reads these from its env (AI_ENABLED, OPENAI_API_KEY or
 * ANTHROPIC_API_KEY, INSIGHTS_PROVIDER, INSIGHTS_MODEL, INSIGHTS_EFFORT; see
 * apps/api/src/config.ts) and passes them in.
 */
export interface InsightsAi {
  provider: "openai" | "anthropic";
  apiKey: string;
  /** Model name. Defaults: gpt-5.5 / claude-opus-5. */
  model?: string;
  /** How hard the model thinks. Defaults: medium (OpenAI) / high (Anthropic). */
  effort?: "low" | "medium" | "high";
}

const DEFAULT_MODEL: Record<InsightsAi["provider"], string> = { openai: "gpt-5.5", anthropic: "claude-opus-5" };

/** The model name Insights will use, for the page to show. */
export function insightsModel(ai: InsightsAi): string {
  return ai.model ?? DEFAULT_MODEL[ai.provider];
}

/** The most tool rounds one question may take. Setup needs more than reporting: it reads, describes actions, then plans. */
const MAX_ROUNDS = 30;

export interface AskInput {
  ai: InsightsAi;
  siteId: string;
  scope: ReportScope;
  /** The chat so far, as the page keeps it, ending with the new question. */
  messages: Array<UIMessage | ModelMessage>;
  /** The board on screen now. Follow-up questions change it. */
  board?: unknown;
  signal?: AbortSignal;
  /**
   * More tools and instructions from the caller, like the setup tools the API
   * builds around the person's own RPC context (apps/api/src/setup).
   */
  extraTools?: unknown[];
  extraInstructions?: string;
}

export async function askInsights(input: AskInput): Promise<AsyncIterable<StreamChunk>> {
  const { ai } = input;
  // Loaded here so a server with AI off never loads the AI libraries.
  const { chat, maxIterations } = await import("@tanstack/ai");

  const site = await prisma.site.findUnique({ where: { id: input.siteId }, select: { timezone: true } });
  const timezone = site?.timezone ?? "UTC";
  const nowMs = Date.now();
  // A v1 board from an older page is turned into a spec here.
  const board: Board = parseBoard(input.board) ?? emptyBoard();

  const abortController = new AbortController();
  input.signal?.addEventListener("abort", () => abortController.abort(), { once: true });

  const shared = {
    messages: input.messages,
    tools: [
      ...insightsTools({ scope: input.scope, timezone, nowMs, board }),
      ...(input.extraTools ?? []),
    ] as ReturnType<typeof insightsTools>,
    agentLoopStrategy: maxIterations(MAX_ROUNDS),
    abortController,
  };
  // The extra instructions don't change between questions either, so they cache.
  const stable = stableInstructions() + (input.extraInstructions ?? "");
  const turn = turnInstructions({ timezone, nowMs, board });

  if (ai.provider === "openai") {
    const { createOpenaiChat } = await import("@tanstack/ai-openai");
    const model = insightsModel(ai) as Parameters<typeof createOpenaiChat>[0];
    return chat({
      ...shared,
      adapter: createOpenaiChat(model, ai.apiKey),
      // OpenAI caches a repeated prefix on its own; stable text goes first.
      systemPrompts: [stable, turn],
      modelOptions: { reasoning: { effort: ai.effort ?? "medium" } } as never,
    });
  }

  const { createAnthropicChat } = await import("@tanstack/ai-anthropic");
  const model = insightsModel(ai) as Parameters<typeof createAnthropicChat>[0];
  return chat({
    ...shared,
    adapter: createAnthropicChat(model, ai.apiKey),
    systemPrompts: [
      // Same text every time, so it caches.
      { content: stable, metadata: { cache_control: { type: "ephemeral" } } },
      turn,
    ],
    modelOptions: {
      thinking: { type: "adaptive" },
      output_config: { effort: ai.effort ?? "high" },
      max_tokens: 16000,
    },
  });
}

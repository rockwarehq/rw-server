import prisma from "@rw/db";
import { chat, maxIterations, type ModelMessage, type StreamChunk, type UIMessage } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { openaiText } from "@tanstack/ai-openai";
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
 *   INSIGHTS_PROVIDER  "openai" or "anthropic". Defaults to whichever key is set
 *                      (OpenAI first).
 *   INSIGHTS_MODEL     Model name. Defaults: gpt-5.5 / claude-opus-5.
 *   INSIGHTS_EFFORT    How hard the model thinks: low, medium or high.
 *
 * Keys: OPENAI_API_KEY or ANTHROPIC_API_KEY.
 */
type Provider = "openai" | "anthropic";

function provider(): Provider | undefined {
  const chosen = process.env.INSIGHTS_PROVIDER;
  if (chosen === "openai" || chosen === "anthropic") return chosen;
  if (chosen) return undefined;
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return undefined;
}

const KEY_BY_PROVIDER: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export function insightsEnabled(): boolean {
  const chosen = provider();
  return chosen !== undefined && Boolean(process.env[KEY_BY_PROVIDER[chosen]]);
}

const DEFAULT_MODEL: Record<Provider, string> = { openai: "gpt-5.5", anthropic: "claude-opus-5" };

/** The model name Insights will use, for the page to show. */
export function insightsModel(): string | undefined {
  const chosen = provider();
  return chosen ? (process.env.INSIGHTS_MODEL ?? DEFAULT_MODEL[chosen]) : undefined;
}

const EFFORTS = ["low", "medium", "high"] as const;
type Effort = (typeof EFFORTS)[number];
const effort = (fallback: Effort): Effort => {
  const value = process.env.INSIGHTS_EFFORT as Effort | undefined;
  return value && EFFORTS.includes(value) ? value : fallback;
};

/** The most tool rounds one question may take. Setup needs more than reporting: it reads, describes actions, then plans. */
const MAX_ROUNDS = 30;

export interface AskInput {
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
  const chosen = provider();
  if (!chosen || !insightsEnabled()) throw new Error("Insights has no AI provider set up.");

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

  if (chosen === "openai") {
    const model = insightsModel() as Parameters<typeof openaiText>[0];
    return chat({
      ...shared,
      adapter: openaiText(model),
      // OpenAI caches a repeated prefix on its own; stable text goes first.
      systemPrompts: [stable, turn],
      modelOptions: { reasoning: { effort: effort("medium") } } as never,
    });
  }

  const model = insightsModel() as Parameters<typeof anthropicText>[0];
  return chat({
    ...shared,
    adapter: anthropicText(model),
    systemPrompts: [
      // Same text every time, so it caches.
      { content: stable, metadata: { cache_control: { type: "ephemeral" } } },
      turn,
    ],
    modelOptions: {
      thinking: { type: "adaptive" },
      output_config: { effort: effort("high") },
      max_tokens: 16000,
    },
  });
}

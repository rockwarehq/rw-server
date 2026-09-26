import prisma from "@rw/db";
import { chat, maxIterations, type ModelMessage, type StreamChunk, type UIMessage } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { openaiText } from "@tanstack/ai-openai";
import type { ReportScope } from "../reporting/types.js";
import { type Board, boardSchema, emptyBoard } from "./board.js";
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

const EFFORTS = ["low", "medium", "high"] as const;
type Effort = (typeof EFFORTS)[number];
const effort = (fallback: Effort): Effort => {
  const value = process.env.INSIGHTS_EFFORT as Effort | undefined;
  return value && EFFORTS.includes(value) ? value : fallback;
};

/** The most tool rounds one question may take. */
const MAX_ROUNDS = 12;

export interface AskInput {
  siteId: string;
  scope: ReportScope;
  /** The chat so far, as the page keeps it, ending with the new question. */
  messages: Array<UIMessage | ModelMessage>;
  /** The board on screen now. Follow-up questions change it. */
  board?: unknown;
  signal?: AbortSignal;
}

export async function askInsights(input: AskInput): Promise<AsyncIterable<StreamChunk>> {
  const chosen = provider();
  if (!chosen || !insightsEnabled()) throw new Error("Insights has no AI provider set up.");

  const site = await prisma.site.findUnique({ where: { id: input.siteId }, select: { timezone: true } });
  const timezone = site?.timezone ?? "UTC";
  const nowMs = Date.now();
  const parsed = boardSchema.safeParse(input.board);
  const board: Board = parsed.success ? parsed.data : emptyBoard();

  const abortController = new AbortController();
  input.signal?.addEventListener("abort", () => abortController.abort(), { once: true });

  const shared = {
    messages: input.messages,
    tools: insightsTools({ scope: input.scope, timezone, nowMs, board }),
    agentLoopStrategy: maxIterations(MAX_ROUNDS),
    abortController,
  };
  const stable = stableInstructions();
  const turn = turnInstructions({ timezone, nowMs, board });

  if (chosen === "openai") {
    const model = (process.env.INSIGHTS_MODEL ?? "gpt-5.5") as Parameters<typeof openaiText>[0];
    return chat({
      ...shared,
      adapter: openaiText(model),
      // OpenAI caches a repeated prefix on its own; stable text goes first.
      systemPrompts: [stable, turn],
      modelOptions: { reasoning: { effort: effort("medium") } } as never,
    });
  }

  const model = (process.env.INSIGHTS_MODEL ?? "claude-opus-5") as Parameters<typeof anthropicText>[0];
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

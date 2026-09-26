import prisma from "@rw/db";
import { chat, maxIterations, type ModelMessage, type StreamChunk, type UIMessage } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import type { ReportScope } from "../reporting/types.js";
import { type Board, boardSchema, emptyBoard } from "./board.js";
import { stableInstructions, turnInstructions } from "./prompt.js";
import { insightsTools } from "./tools.js";

// One question in, a stream of events out: the AI's words, its tool calls,
// and a board event each time it changes the board. The page sends the whole
// chat each time; nothing is stored on the server.

/**
 * Which AI runs Insights. One switch, so another provider can slot in later:
 * INSIGHTS_PROVIDER (only "anthropic" today), INSIGHTS_MODEL, INSIGHTS_EFFORT.
 * The Anthropic adapter reads ANTHROPIC_API_KEY.
 */
function insightsAdapter() {
  const provider = process.env.INSIGHTS_PROVIDER ?? "anthropic";
  if (provider !== "anthropic") throw new Error(`Unknown INSIGHTS_PROVIDER: ${provider}`);
  const model = (process.env.INSIGHTS_MODEL ?? "claude-opus-5") as Parameters<typeof anthropicText>[0];
  return anthropicText(model);
}

const EFFORTS = ["low", "medium", "high", "max"] as const;
type Effort = (typeof EFFORTS)[number];
const effort = (): Effort => {
  const value = process.env.INSIGHTS_EFFORT as Effort | undefined;
  return value && EFFORTS.includes(value) ? value : "high";
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

export function insightsEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function askInsights(input: AskInput): Promise<AsyncIterable<StreamChunk>> {
  const site = await prisma.site.findUnique({ where: { id: input.siteId }, select: { timezone: true } });
  const timezone = site?.timezone ?? "UTC";
  const nowMs = Date.now();
  const parsed = boardSchema.safeParse(input.board);
  const board: Board = parsed.success ? parsed.data : emptyBoard();

  const abortController = new AbortController();
  input.signal?.addEventListener("abort", () => abortController.abort(), { once: true });

  return chat({
    adapter: insightsAdapter(),
    messages: input.messages,
    systemPrompts: [
      // Same text every time, so it caches.
      { content: stableInstructions(), metadata: { cache_control: { type: "ephemeral" } } },
      turnInstructions({ timezone, nowMs, board }),
    ],
    tools: insightsTools({ scope: input.scope, timezone, nowMs, board }),
    modelOptions: {
      thinking: { type: "adaptive" },
      output_config: { effort: effort() },
      max_tokens: 16000,
    },
    agentLoopStrategy: maxIterations(MAX_ROUNDS),
    abortController,
  });
}

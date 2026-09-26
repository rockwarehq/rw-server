import { ORPCError, eventIterator } from "@orpc/server";
import { z } from "zod";
import { askInsights, insightsEnabled, insightsModel } from "@rw/services/insights/ask";
import { userRequired } from "./middleware.js";

// Insights: ask a question in plain words, get a board of reports back.
//
// `ask` streams the AI's work as it happens (words, tool calls, and a
// "insights.board" event each time the board changes). The page keeps the
// chat and the board and sends both back with each new question; nothing is
// stored here. A board is saved like any view, through savedView page "board".
//
// Every query the AI runs goes through the report catalog with the caller's
// own site and workcenter scope, so it can never see more than they can.

/** Questions per person per window. The AI is slow and costs money per call. */
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const recentAsks = new Map<string, number[]>();

function allowAsk(userId: string, now = Date.now()): boolean {
  const recent = (recentAsks.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    recentAsks.set(userId, recent);
    return false;
  }
  recent.push(now);
  recentAsks.set(userId, recent);
  return true;
}

const askSchema = z.object({
  siteId: z.uuid(),
  // The chat so far, in TanStack AI message shape. Shape-checked by the chat
  // runner; here we only cap the size.
  messages: z
    .array(z.looseObject({ role: z.string() }))
    .min(1)
    .max(80),
  board: z.unknown().optional(),
});

export const status = userRequired.input(z.object({ siteId: z.uuid() })).handler(async ({ input, context }) => {
  context.access.list("VIEW", input.siteId, "WORKCENTER");
  const enabled = insightsEnabled();
  return { enabled, ...(enabled ? { model: insightsModel() } : {}) };
});

export const ask = userRequired
  .input(askSchema)
  // AG-UI events from TanStack AI. Their shape is the library's contract, so
  // they pass through as-is.
  .output(eventIterator(z.looseObject({ type: z.string() })))
  .handler(async function* ({ input, context, signal }) {
    // Same check as report.query: whoever can read floor data can ask about it.
    const scope = context.access.list("VIEW", input.siteId, "WORKCENTER");
    if (!insightsEnabled()) {
      throw new ORPCError("PRECONDITION_FAILED", { message: "Insights is not set up on this server." });
    }
    if (!allowAsk(context.current.user.id)) {
      throw new ORPCError("TOO_MANY_REQUESTS", { message: "Too many questions. Wait a few minutes and try again." });
    }

    const stream = await askInsights({
      siteId: input.siteId,
      scope,
      // The chat runner checks each message; the schema above only bounds size.
      messages: input.messages as unknown as Parameters<typeof askInsights>[0]["messages"],
      board: input.board,
      signal,
    });
    for await (const chunk of stream) {
      yield chunk as { type: string };
    }
  });

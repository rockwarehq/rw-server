import { ORPCError, eventIterator } from "@orpc/server";
import { z } from "zod";
import { askInsights, insightsModel } from "@rw/services/insights/ask";
import { aiConfig } from "../config.js";
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
//
// Two flags turn this on (apps/api/src/config.ts): AI_ENABLED for asking and
// boards, CONFIG_AGENT_ENABLED for the setup assistant (plans that change data).

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
  const ai = aiConfig.insights;
  return {
    enabled: aiConfig.enabled,
    configAgent: aiConfig.configAgentEnabled,
    ...(aiConfig.enabled && ai ? { model: insightsModel(ai) } : {}),
  };
});

export const ask = userRequired
  .input(askSchema)
  // AG-UI events from TanStack AI. Their shape is the library's contract, so
  // they pass through as-is.
  .output(eventIterator(z.looseObject({ type: z.string() })))
  .handler(async function* ({ input, context, signal }) {
    // Same check as report.query: whoever can read floor data can ask about it.
    const scope = context.access.list("VIEW", input.siteId, "WORKCENTER");
    const ai = aiConfig.insights;
    if (!aiConfig.enabled || !ai) {
      throw new ORPCError("PRECONDITION_FAILED", { message: "Insights is not set up on this server." });
    }
    if (!allowAsk(context.current.user.id)) {
      throw new ORPCError("TOO_MANY_REQUESTS", { message: "Too many questions. Wait a few minutes and try again." });
    }

    // The setup tools run the real procedures as this person (apps/api/src/setup).
    // Loaded here, not at the top, because they read the router this file is part of.
    // Only offered when the setup assistant is turned on.
    const setup = aiConfig.configAgentEnabled ? await import("../setup/tools.js") : undefined;
    const stream = await askInsights({
      ai,
      siteId: input.siteId,
      scope,
      extraTools: setup?.setupTools(context, input.siteId),
      extraInstructions: setup?.SETUP_INSTRUCTIONS,
      // The chat runner checks each message; the schema above only bounds size.
      messages: input.messages as unknown as Parameters<typeof askInsights>[0]["messages"],
      board: input.board,
      signal,
    });
    for await (const chunk of stream) {
      yield chunk as { type: string };
    }
  });

/**
 * Apply a setup plan the assistant proposed, after the person reviewed it.
 * Runs each step as the person (every procedure checks access itself) and
 * streams one result per step. Dangerous steps run only when listed in
 * `confirm`. No AI is involved here.
 */
export const applyPlan = userRequired
  .input(
    z.object({
      siteId: z.uuid(),
      planId: z.uuid(),
      confirm: z.array(z.string().max(32)).max(60).default([]),
    }),
  )
  .output(
    eventIterator(
      z.object({
        stepId: z.string(),
        ok: z.boolean(),
        skipped: z.boolean().optional(),
        resultId: z.string().optional(),
        error: z.string().optional(),
      }),
    ),
  )
  .handler(async function* ({ input, context }) {
    // Seeing the plant is enough to start; each step checks its own access.
    context.access.list("VIEW", input.siteId, "WORKCENTER");
    if (!aiConfig.configAgentEnabled) {
      throw new ORPCError("PRECONDITION_FAILED", { message: "The setup assistant is not turned on on this server." });
    }
    const plans = await import("../setup/plans.js");
    const plan = plans.planFor(input.planId, context.current.user.id);
    if ("error" in plan) throw new ORPCError("NOT_FOUND", { message: plan.error });
    if (plan.siteId !== input.siteId)
      throw new ORPCError("BAD_REQUEST", { message: "This plan is for another plant." });
    for await (const result of plans.applyPlan(context, plan, new Set(input.confirm))) {
      yield "skipped" in result ? { stepId: result.skipped, ok: false, skipped: true, error: result.reason } : result;
    }
  });

import type { BetaContentBlockParam, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

import type { AgentUsage } from "./events.js";

// Sessions, their inbox of inputs, and their model history (verbatim Messages
// API turns, so thinking blocks replay unchanged).

type Tx = Prisma.TransactionClient;
export type SessionTrigger = "CHAT" | "HOOK_EVENT" | "SCHEDULE" | "AGENT";
export type SessionStatus = "IDLE" | "QUEUED" | "RUNNING" | "WAITING_APPROVAL" | "FAILED";

export const sessionSelect = {
  id: true,
  siteId: true,
  agentKey: true,
  agentVersion: true,
  parentSessionId: true,
  trigger: true,
  triggerRef: true,
  actorUserId: true,
  title: true,
  status: true,
  lastSeq: true,
  usage: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface CreateSessionInput {
  siteId: string;
  agentKey: string;
  agentVersion: number;
  actorUserId: string;
  title: string;
  trigger: SessionTrigger;
  /** Dedupes trigger-started sessions: one session per (site, triggerRef). */
  triggerRef?: string | null;
  parentSessionId?: string | null;
}

export async function createSession(input: CreateSessionInput) {
  const data = {
    siteId: input.siteId,
    agentKey: input.agentKey,
    agentVersion: input.agentVersion,
    actorUserId: input.actorUserId,
    title: input.title.slice(0, 120) || "New session",
    trigger: input.trigger,
    triggerRef: input.triggerRef ?? null,
    parentSessionId: input.parentSessionId ?? null,
  };
  if (!input.triggerRef) {
    return { session: await prisma.agentSession.create({ data, select: sessionSelect }), created: true };
  }
  const existing = await prisma.agentSession.findUnique({
    where: { siteId_triggerRef: { siteId: input.siteId, triggerRef: input.triggerRef } },
    select: sessionSelect,
  });
  if (existing) return { session: existing, created: false };
  try {
    return { session: await prisma.agentSession.create({ data, select: sessionSelect }), created: true };
  } catch {
    // Lost a race with a redelivered event.
    const session = await prisma.agentSession.findUniqueOrThrow({
      where: { siteId_triggerRef: { siteId: input.siteId, triggerRef: input.triggerRef } },
      select: sessionSelect,
    });
    return { session, created: false };
  }
}

export interface InputContextItem {
  kind: string;
  id?: string;
  label: string;
  detail?: string;
}

/** Admit a prompt. The id is the client's; a retried submission is a no-op. */
export async function admitInput(sessionId: string, input: { id: string; text: string; context?: InputContextItem[] }) {
  await prisma.agentInput.createMany({
    data: [
      {
        id: input.id,
        sessionId,
        text: input.text,
        context: (input.context ?? []) as unknown as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  });
}

export async function admittedInputs(sessionId: string) {
  return prisma.agentInput.findMany({
    where: { sessionId, status: "ADMITTED" },
    orderBy: { createdAt: "asc" },
  });
}

export async function setStatus(sessionId: string, status: SessionStatus, tx: Tx = prisma) {
  await tx.agentSession.update({ where: { id: sessionId }, data: { status } });
}

export async function history(sessionId: string): Promise<BetaMessageParam[]> {
  const rows = await prisma.agentMessage.findMany({ where: { sessionId }, orderBy: { seq: "asc" } });
  return rows.map((row) => ({
    role: row.role === "USER" ? "user" : "assistant",
    content: row.content as unknown as BetaContentBlockParam[],
  }));
}

export async function appendMessage(
  tx: Tx,
  sessionId: string,
  message: BetaMessageParam,
  meta: { usage?: AgentUsage; model?: string } = {},
) {
  const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  const last = await tx.agentMessage.findFirst({
    where: { sessionId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  await tx.agentMessage.create({
    data: {
      sessionId,
      seq: (last?.seq ?? 0) + 1,
      role: message.role === "user" ? "USER" : "ASSISTANT",
      content: content as unknown as Prisma.InputJsonValue,
      usage: meta.usage ? (meta.usage as unknown as Prisma.InputJsonValue) : undefined,
      model: meta.model,
    },
  });
  if (meta.usage) {
    const session = await tx.agentSession.findUniqueOrThrow({ where: { id: sessionId }, select: { usage: true } });
    const current = (session.usage ?? {}) as Partial<AgentUsage>;
    await tx.agentSession.update({
      where: { id: sessionId },
      data: {
        usage: {
          inputTokens: (current.inputTokens ?? 0) + meta.usage.inputTokens,
          outputTokens: (current.outputTokens ?? 0) + meta.usage.outputTokens,
          cacheReadInputTokens: (current.cacheReadInputTokens ?? 0) + meta.usage.cacheReadInputTokens,
          cacheCreationInputTokens: (current.cacheCreationInputTokens ?? 0) + meta.usage.cacheCreationInputTokens,
        },
      },
    });
  }
}

/** The tool_use blocks of the last assistant turn that have no tool_result yet. */
export function pendingToolUses(messages: BetaMessageParam[]): Array<{ id: string; name: string; input: unknown }> {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant" || !Array.isArray(last.content)) return [];
  return last.content.flatMap((block) =>
    block.type === "tool_use" ? [{ id: block.id, name: block.name, input: block.input }] : [],
  );
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A user turn with the engineer's editor context as <editor_context>. */
export function renderUserTurn(message: string, context: InputContextItem[] = []): string {
  if (context.length === 0) return message;
  const items = context
    .map((item) => {
      const attrs = [`kind="${escapeXml(item.kind)}"`, item.id ? `id="${escapeXml(item.id)}"` : null]
        .filter(Boolean)
        .join(" ");
      const body = item.detail ? `\n${escapeXml(item.detail)}\n` : "";
      return `<item ${attrs} label="${escapeXml(item.label)}">${body}</item>`;
    })
    .join("\n");
  return `<editor_context>\n${items}\n</editor_context>\n\n${message}`;
}

import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

import { publish } from "./bus.js";

// A session's events, after opencode's split: durable events are stored with a
// per-session seq and replayed to any client from a cursor; live events
// (streaming deltas, status) are broadcast and never stored. Every durable
// type carries a version, so stored logs stay readable when shapes change.

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ContextChip {
  kind: string;
  label: string;
}

// Written out by hand (not inferred from schemas) so the published client's
// types stay small and readable.
export type DurableEvent =
  | { type: "input.consumed"; inputId: string; text: string; context: ContextChip[] }
  | { type: "turn.started"; agentKey: string }
  | { type: "text.ended"; text: string }
  | { type: "thinking.ended"; text: string }
  | { type: "tool.called"; toolUseId: string; name: string; input: unknown }
  | {
      type: "tool.completed";
      toolUseId: string;
      name: string;
      output: string;
      truncated: boolean;
      metadata?: Record<string, unknown>;
    }
  | { type: "tool.failed"; toolUseId: string; name: string; error: string; interrupted?: boolean }
  | {
      type: "permission.asked";
      requestId: string;
      toolUseId: string;
      toolName: string;
      permission: string;
      patterns: string[];
      metadata: Record<string, unknown>;
    }
  | {
      type: "permission.replied";
      requestId: string;
      reply: "once" | "always" | "reject" | "expired";
      feedback: string | null;
      repliedById: string | null;
    }
  | { type: "changeset.proposed"; changesetId: string; title: string; valid: boolean }
  | { type: "changeset.applied"; changesetId: string; title: string }
  | { type: "subagent.started"; childSessionId: string; agentKey: string; toolUseId: string }
  | { type: "subagent.finished"; childSessionId: string; status: string }
  | { type: "step.finished"; usage: AgentUsage; model: string }
  | { type: "retry"; attempt: number; nextAt: string; message: string }
  | { type: "error"; message: string }
  | { type: "turn.finished"; stopReason: string };

export type LiveEvent =
  | { type: "text.delta"; text: string }
  | { type: "thinking.delta"; text: string }
  | { type: "status"; status: "IDLE" | "QUEUED" | "RUNNING" | "WAITING_APPROVAL" | "FAILED" };

export type DurableType = DurableEvent["type"];
export type LiveType = LiveEvent["type"];

const DURABLE_TYPES: readonly DurableType[] = [
  "input.consumed",
  "turn.started",
  "text.ended",
  "thinking.ended",
  "tool.called",
  "tool.completed",
  "tool.failed",
  "permission.asked",
  "permission.replied",
  "changeset.proposed",
  "changeset.applied",
  "subagent.started",
  "subagent.finished",
  "step.finished",
  "retry",
  "error",
  "turn.finished",
];
const LIVE_TYPES: readonly LiveType[] = ["text.delta", "thinking.delta", "status"];

export const EVENT_VERSION = 1;

/** What a client receives: durable events carry their seq, live ones don't. */
export type WireEvent = (DurableEvent & { seq: number; at: string }) | (LiveEvent & { seq: null; at: string });

{
  const seen = new Set<string>();
  for (const type of [...DURABLE_TYPES, ...LIVE_TYPES]) {
    if (seen.has(type)) throw new Error(`duplicate agent event type ${type}`);
    seen.add(type);
  }
}

export function isDurable(type: string): type is DurableType {
  return (DURABLE_TYPES as readonly string[]).includes(type);
}

const storedType = (type: DurableType) => `${type}.${EVENT_VERSION}`;

function fromStored(type: string): DurableType | null {
  const match = /^(.*)\.(\d+)$/.exec(type);
  if (!match) return null;
  return isDurable(match[1]) ? match[1] : null;
}

export const wakeSubject = (sessionId: string) => `agent.session.${sessionId}.wake`;
export const liveSubject = (sessionId: string) => `agent.session.${sessionId}.live`;

type Tx = Prisma.TransactionClient;

/**
 * Append durable events in order, inside the caller's transaction, and bump
 * the session's lastSeq. Call publishCommitted after the transaction commits.
 */
export async function appendEvents(tx: Tx, sessionId: string, events: DurableEvent[]): Promise<number> {
  if (events.length === 0) {
    const session = await tx.agentSession.findUniqueOrThrow({ where: { id: sessionId }, select: { lastSeq: true } });
    return session.lastSeq;
  }
  const session = await tx.agentSession.update({
    where: { id: sessionId },
    data: { lastSeq: { increment: events.length } },
    select: { lastSeq: true },
  });
  const first = session.lastSeq - events.length + 1;
  await tx.agentEvent.createMany({
    data: events.map(({ type, ...payload }, index) => ({
      sessionId,
      seq: first + index,
      type: storedType(type),
      payload: payload as Prisma.InputJsonValue,
    })),
  });
  return session.lastSeq;
}

/** Commit events in their own transaction and wake subscribers. */
export async function commitEvents(sessionId: string, events: DurableEvent[]): Promise<number> {
  const seq = await prisma.$transaction((tx) => appendEvents(tx, sessionId, events));
  publishCommitted(sessionId);
  return seq;
}

export function publishCommitted(sessionId: string): void {
  void publish(wakeSubject(sessionId), "");
}

export function publishLive(sessionId: string, event: LiveEvent): void {
  void publish(liveSubject(sessionId), JSON.stringify({ ...event, seq: null, at: new Date().toISOString() }));
}

export async function readEvents(sessionId: string, after: number, limit = 500): Promise<WireEvent[]> {
  const rows = await prisma.agentEvent.findMany({
    where: { sessionId, seq: { gt: after } },
    orderBy: { seq: "asc" },
    take: limit,
  });
  return rows.flatMap((row) => {
    const type = fromStored(row.type);
    if (!type) return [];
    return [
      {
        ...(row.payload as object),
        type,
        seq: row.seq,
        at: row.createdAt.toISOString(),
      } as WireEvent,
    ];
  });
}

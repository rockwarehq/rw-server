import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { send } from "@rw/services/notification/index";

import { moduleLogger } from "../logger.js";
import type { ResolvedAgent } from "./agents.js";
import { appendEvents, publishCommitted } from "./events.js";
import { enqueueRun } from "./queue.js";

// Tool calls that wait for a person. Asking persists a request and parks the
// run; answering records the reply and queues the run, which resumes by
// turning the answer into the tool's result. Nothing waits in memory, so an
// answer days later, on any api node, resumes the run.

const log = moduleLogger("agent-approvals");
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export type ApprovalReply = "once" | "always" | "reject";

export interface AskInput {
  sessionId: string;
  siteId: string;
  trigger: string;
  agent: ResolvedAgent;
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  permission: string;
  patterns: string[];
}

async function describe(permission: string, toolInput: unknown, siteId: string): Promise<Record<string, unknown>> {
  if (permission !== "changeset.apply") return {};
  const changesetId = (toolInput as { changesetId?: string }).changesetId;
  if (!changesetId) return {};
  const changeset = await prisma.graphChangeset.findFirst({
    where: { id: changesetId, siteId },
    select: { id: true, title: true, rationale: true },
  });
  return changeset
    ? { changesetId: changeset.id, title: changeset.title, rationale: changeset.rationale }
    : { changesetId };
}

export async function ask(input: AskInput, tx: Prisma.TransactionClient): Promise<{ requestId: string }> {
  const metadata = await describe(input.permission, input.toolInput, input.siteId);
  const request = await tx.agentPermissionRequest.upsert({
    where: { sessionId_toolUseId: { sessionId: input.sessionId, toolUseId: input.toolUseId } },
    create: {
      sessionId: input.sessionId,
      siteId: input.siteId,
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      toolInput: (input.toolInput ?? {}) as Prisma.InputJsonValue,
      permission: input.permission,
      patterns: input.patterns,
      metadata: metadata as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + DEFAULT_EXPIRY_MS),
    },
    update: {},
  });
  await appendEvents(tx, input.sessionId, [
    {
      type: "permission.asked",
      requestId: request.id,
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      permission: input.permission,
      patterns: input.patterns,
      metadata,
    },
  ]);
  return { requestId: request.id };
}

/**
 * Tell the agent's notification group, for runs nobody is watching. A chat's
 * own user sees the request in the conversation.
 */
export async function notifyApprovers(input: AskInput, requestId: string): Promise<void> {
  if (input.trigger === "CHAT" || !input.agent.notificationGroupId) return;
  const metadata = (await prisma.agentPermissionRequest.findUnique({ where: { id: requestId } }))?.metadata as
    | { title?: string }
    | undefined;
  const what =
    input.permission === "changeset.apply"
      ? `apply the changeset "${metadata?.title ?? "untitled"}"`
      : `use ${input.toolName} (${input.permission})`;
  const result = await send({
    groupIds: [input.agent.notificationGroupId],
    subject: `${input.agent.name} needs approval`,
    body: `The ${input.agent.name} agent wants to ${what}. Review it in Console → Agents → Approvals.`,
    source: "SYSTEM",
    sourceType: "agent",
    sourceRef: requestId,
    dedupeKey: `agent-approval:${requestId}`,
  }).catch((err: unknown) => ({ error: String(err), code: "SEND_FAILED" }));
  if ("error" in result) {
    log.warn({ requestId, error: result.error }, "approval notification not sent");
    return;
  }
  await prisma.agentPermissionRequest.update({ where: { id: requestId }, data: { notifiedAt: new Date() } });
}

export class ApprovalError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "CLOSED" | "FORBIDDEN" | "BAD_REQUEST",
    message: string,
  ) {
    super(message);
  }
}

export interface ReplyInput {
  requestId: string;
  siteId: string;
  reply: ApprovalReply;
  feedback?: string | null;
  userId: string;
}

/** Record a person's answer and queue the run to resume. */
export async function reply(input: ReplyInput) {
  const request = await prisma.agentPermissionRequest.findFirst({
    where: { id: input.requestId, siteId: input.siteId },
    include: { session: { select: { agentKey: true } } },
  });
  if (!request) throw new ApprovalError("NOT_FOUND", "Approval request not found");
  if (request.status !== "PENDING") throw new ApprovalError("CLOSED", "This request was already answered");
  if (request.expiresAt < new Date()) {
    await expireStale();
    throw new ApprovalError("CLOSED", "This request expired");
  }
  if (input.reply === "always" && request.permission === "changeset.apply") {
    throw new ApprovalError("BAD_REQUEST", "Changesets are approved one at a time");
  }

  const approved = input.reply !== "reject";
  const updated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.agentPermissionRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: {
        status: approved ? "APPROVED" : "REJECTED",
        reply: input.reply,
        feedback: input.feedback?.trim() || null,
        repliedById: input.userId,
        repliedAt: new Date(),
      },
    });
    if (claimed.count === 0) throw new ApprovalError("CLOSED", "This request was already answered");
    if (input.reply === "always") {
      await tx.agentPermissionRule.createMany({
        data: request.patterns.map((pattern) => ({
          siteId: request.siteId,
          agentKey: request.session.agentKey,
          permission: request.permission,
          pattern,
          action: "allow",
          createdById: input.userId,
        })),
      });
    }
    await appendEvents(tx, request.sessionId, [
      {
        type: "permission.replied",
        requestId: request.id,
        reply: input.reply,
        feedback: input.feedback?.trim() || null,
        repliedById: input.userId,
      },
    ]);
    await tx.agentSession.update({ where: { id: request.sessionId }, data: { status: "QUEUED" } });
    return tx.agentPermissionRequest.findUniqueOrThrow({ where: { id: request.id } });
  });
  publishCommitted(request.sessionId);
  await enqueueRun(request.sessionId, "approval");
  return updated;
}

/** Close requests nobody answered in time; their runs resume with a refusal. */
export async function expireStale(): Promise<number> {
  const stale = await prisma.agentPermissionRequest.findMany({
    where: { status: "PENDING", expiresAt: { lt: new Date() } },
    select: { id: true, sessionId: true },
    take: 100,
  });
  for (const request of stale) {
    const expired = await prisma.$transaction(async (tx) => {
      const claimed = await tx.agentPermissionRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: { status: "EXPIRED", reply: "expired", repliedAt: new Date() },
      });
      if (claimed.count === 0) return false;
      await appendEvents(tx, request.sessionId, [
        { type: "permission.replied", requestId: request.id, reply: "expired", feedback: null, repliedById: null },
      ]);
      return true;
    });
    if (expired) {
      publishCommitted(request.sessionId);
      await enqueueRun(request.sessionId, "approval-expired");
    }
  }
  return stale.length;
}

export async function listApprovals(siteId: string, status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED") {
  if (status === "PENDING") await expireStale();
  return prisma.agentPermissionRequest.findMany({
    where: { siteId, status },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      session: { select: { id: true, title: true, agentKey: true, trigger: true, actorUserId: true } },
    },
  });
}

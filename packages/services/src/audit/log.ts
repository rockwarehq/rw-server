import prisma from "@rw/db";
import type { AuditAction, Prisma } from "@rw/db";

import { type AuditVia, auditContext } from "./context.js";

export interface LogEventParams {
  action: AuditAction;
  /** The person the event is about (an invitee, a locked-out user). */
  userId?: string;
  /** Who did it. Defaults to the request's caller. */
  actorId?: string;
  workspaceId?: string;
  /** The plant; null when the event belongs to none (don't fall back to the caller's). */
  siteId?: string | null;
  /** The record it happened to, e.g. ("product", id). */
  entityType?: string;
  entityId?: string;
  /** What changed: { field: { from, to } }. Never secrets. */
  changes?: Record<string, { from: unknown; to: unknown }>;
  /** A versioned record's new version, and the one it replaced. */
  versionId?: string;
  previousVersionId?: string;
  via?: AuditVia;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  /**
   * Write inside the caller's transaction: the change and its audit entry
   * commit or roll back together, and a failed audit write fails the change.
   */
  tx?: Prisma.TransactionClient;
}

/**
 * Record an event in the audit trail. Who, where from and how they came in
 * are taken from the request's audit context unless given.
 *
 * With `tx` it writes in that transaction and throws like any other write.
 * Without it, it runs on its own after the fact and never throws: an entry
 * that fails is logged, and the action it describes stands.
 */
export async function logEvent(params: LogEventParams): Promise<void> {
  const context = auditContext();
  const actor = context?.actor;
  const data: Prisma.AuditLogUncheckedCreateInput = {
    action: params.action,
    userId: params.userId,
    actorId: params.actorId ?? actor?.actorId,
    // Before anyone is signed in (a failed sign-in, a reset by code) there's no
    // caller: the entry still belongs to the account, the one workspace.
    workspaceId: params.workspaceId ?? actor?.workspaceId ?? (await accountWorkspaceId(params.tx)),
    siteId: params.siteId === null ? null : (params.siteId ?? stringOf(params.metadata?.siteId) ?? actor?.siteId),
    entityType: params.entityType,
    entityId: params.entityId,
    changes: (params.changes as Prisma.InputJsonValue | undefined) ?? undefined,
    versionId: params.versionId,
    previousVersionId: params.previousVersionId,
    via: params.via ?? actor?.via,
    requestId: context?.requestId,
    ipAddress: params.ipAddress ?? context?.ipAddress,
    userAgent: params.userAgent ?? context?.userAgent,
    metadata:
      context?.metadata || params.metadata
        ? ({ ...context?.metadata, ...params.metadata } as Prisma.InputJsonValue)
        : undefined,
  };

  if (params.tx) {
    await params.tx.auditLog.create({ data });
    return;
  }
  try {
    await prisma.auditLog.create({ data });
  } catch (error) {
    console.error("[AUDIT] Failed to log event:", {
      action: params.action,
      actorId: data.actorId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/** The account's workspace; on its own (no `tx`) a failed lookup leaves it out rather than throw. */
async function accountWorkspaceId(tx?: Prisma.TransactionClient): Promise<string | undefined> {
  if (tx) return (await tx.workspace.findFirst({ select: { id: true } }))?.id;
  return prisma.workspace
    .findFirst({ select: { id: true } })
    .then((workspace) => workspace?.id)
    .catch(() => undefined);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A plant id older call sites put in metadata, if it is one. */
function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value : undefined;
}

/**
 * Convenience function for request context
 */
export function extractRequestContext(request: { ip?: string; headers?: { "user-agent"?: string } }): {
  ipAddress?: string;
  userAgent?: string;
} {
  return {
    ipAddress: request.ip,
    userAgent: request.headers?.["user-agent"],
  };
}

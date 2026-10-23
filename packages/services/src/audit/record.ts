import type { Prisma } from "@rw/db";

import { auditContext } from "./context.js";
import { logEvent } from "./log.js";

// A record's own history in the audit trail: created, changed (with each
// field's before and after) and deleted, written in the same transaction as
// the change. For a versioned record (a recording and its immutable versions,
// like Basecamp's recordables) the entry also points at the version the change
// made and the one it replaced; `changes` is then a summary for display, and
// the versions hold the full values. Services call it next to the write; who and where come from the
// audit context. Only the fields a service names are compared, which is also
// what keeps secrets (PIN and badge hashes, credentials) out of the trail.

export type RecordChange = "created" | "updated" | "deleted";

const ACTIONS = {
  created: "RECORD_CREATED",
  updated: "RECORD_UPDATED",
  deleted: "RECORD_DELETED",
} as const;

type Values = Record<string, unknown> | null | undefined;

/** Who is acting, for a column like a version's createdById. */
export function auditActorId(): string | null {
  return auditContext()?.actor?.actorId ?? null;
}

/** A value as the trail stores and compares it: decimals as numbers, dates as ISO strings. */
function plain(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object" && typeof (value as { toNumber?: unknown }).toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

/** The named fields that differ: { field: { from, to } }. */
export function changedValues(before: Values, after: Values, fields: readonly string[]) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of fields) {
    const from = plain(before?.[field]);
    const to = plain(after?.[field]);
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[field] = { from, to };
  }
  return changes;
}

export interface AuditRecordInput {
  change: RecordChange;
  /** e.g. "product", "job", "workcenter" */
  entityType: string;
  entityId: string;
  siteId?: string | null;
  workspaceId?: string | null;
  /** The record's name at the time, so its history reads well even once it's gone. */
  label?: string | null;
  before?: Values;
  after?: Values;
  /** Which fields to compare. Never list secrets. */
  fields: readonly string[];
  /** A versioned record: the version this change made, and the one it replaced. */
  versionId?: string | null;
  previousVersionId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Record a change to a record, in the caller's transaction. An update that
 * changed none of the named fields (and says nothing else) records nothing.
 */
export async function auditRecord(tx: Prisma.TransactionClient, input: AuditRecordInput): Promise<void> {
  const changes = input.change === "deleted" ? {} : changedValues(input.before, input.after, input.fields);
  const changed = Object.keys(changes).length > 0;
  if (input.change === "updated" && !changed && !input.metadata) return;
  await logEvent({
    tx,
    action: ACTIONS[input.change],
    entityType: input.entityType,
    entityId: input.entityId,
    siteId: input.siteId ?? undefined,
    workspaceId: input.workspaceId ?? undefined,
    ...(changed ? { changes } : {}),
    versionId: input.versionId ?? undefined,
    previousVersionId: input.previousVersionId ?? undefined,
    metadata: { ...(input.label ? { label: input.label } : {}), ...input.metadata },
  });
}

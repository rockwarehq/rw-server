import { AsyncLocalStorage } from "node:async_hooks";

// Who is acting, and from where, for the length of one request (or one
// background run). The API opens it for every request and fills in the actor
// once it knows the caller; `logEvent` reads it, so an audit entry carries
// the actor, plant, IP, user agent and how they came in (the UI, an agent, an
// API token) without each call site passing them.

/** How the actor came in. */
export type AuditVia = "ui" | "staff" | "display" | "api-token" | "system" | `agent:${string}`;

export interface AuditActor {
  actorId?: string;
  workspaceId?: string;
  siteId?: string;
  via?: AuditVia;
}

export interface AuditContext {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
  actor?: AuditActor;
  /**
   * Said on every entry written in this context, under the entry's own
   * metadata: what started an agent's run, the import a change came from.
   */
  metadata?: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<AuditContext>();

/** Run `fn` with this audit context; everything it awaits sees it too. */
export function runWithAuditContext<T>(context: AuditContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The audit context of the current request or run, if any. */
export function auditContext(): AuditContext | undefined {
  return storage.getStore();
}

/** Say who is acting, once the caller is known (after authentication). */
export function setAuditActor(actor: AuditActor | undefined): void {
  const context = storage.getStore();
  if (context) context.actor = actor;
}

/** The agent acting in this context, by name, when it is one. */
export function auditAgentName(): string | null {
  const via = storage.getStore()?.actor?.via;
  return via?.startsWith("agent:") ? via.slice("agent:".length) : null;
}

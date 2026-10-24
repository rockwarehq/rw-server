import type { Current } from "@rw/auth/context";
import type { AuditActor } from "@rw/services/audit/index";

/**
 * Who the audit trail says acted, and how they came in: a person in the UI,
 * Rockware staff, a person through an agent they connected, a display, or an
 * API token.
 */
export function auditActorOf(current: Current | null | undefined): AuditActor | undefined {
  if (!current) return undefined;
  switch (current.kind) {
    case "user":
      return {
        actorId: current.user.id,
        workspaceId: current.workspaceId,
        siteId: current.siteId ?? undefined,
        via: current.via ? `agent:${current.via.clientName}` : current.access.person.staff ? "staff" : "ui",
      };
    case "display":
      return { workspaceId: current.workspaceId, siteId: current.siteId, via: "display" };
    case "app":
      return { workspaceId: current.workspaceId, siteId: current.siteId, via: "api-token" };
  }
}

import type { Access, UserAccess } from "./iam/access.js";

// ── Current: who is calling, set once per request ─────────────────────────
// Like Basecamp's `Current`. Anonymous requests have no Current at all.

export interface UserCurrent {
  kind: "user";
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    status: string;
    // When true, the API blocks everything except password change and
    // session endpoints (enforced by the auth plugin).
    mustChangePassword: boolean;
  };
  workspaceId: string;
  /** The token's active site (bound at login / switch-site). */
  siteId: string | null;
  access: UserAccess;
}

export interface DisplayCurrent {
  kind: "display";
  display: {
    id: string;
    name: string | null;
    status: string;
    siteId: string;
    dashboardId: string | null;
    workcenterId: string | null;
    stationId: string | null;
  };
  workspaceId: string;
  siteId: string;
  access: Access;
}

export interface AppCurrent {
  kind: "app";
  tokenId: string;
  scopes: string[];
  workspaceId: string;
  siteId: string;
  access: Access;
}

export type Current = UserCurrent | DisplayCurrent | AppCurrent;

/** The caller when it is a signed-in user; undefined otherwise. */
export function asUser(current: Current | null | undefined): UserCurrent | undefined {
  return current?.kind === "user" ? current : undefined;
}

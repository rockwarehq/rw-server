import { type IAMContext, Principal } from "../context.js";
import {
  type AccessibleSites,
  getAccessibleSites as defaultGetAccessibleSites,
  hasPermission as defaultHasPermission,
  type Permission,
  snapshotAccessibleSites,
  snapshotHasPermission,
} from "./permissions.js";
import { resolveSiteRef as defaultResolveSiteRef, type ResolvableSiteRef } from "./policy-resolvers.js";

// ── Centralized authorization decisions ──────────────────────────────────
// One call per protected operation: the caller declares the required
// permission and where the site scope comes from; the policy returns either
// a proven scope (workspaceId + siteId) or a typed denial. Never throws —
// transports map PolicyDenial to their own wire errors (rpc/authz.ts,
// api/authz.ts in the API app), consistent with ADR-0003.
//
// Deployments run a single workspace, so the policy enforces permissions and
// SITE-level scope only; it does not verify workspace containment of
// resources (vacuously true) and adds no queries for it.

/** Where the site scope for a check comes from. */
export type SiteRef =
  | { kind: "workspace" } // workspace-level action (e.g. site.create)
  | { kind: "site"; siteId: string } // literal id from input/params
  | ResolvableSiteRef; // derived from a resource id via a narrow lookup

export interface PolicyDenial {
  ok: false;
  code: "UNAUTHENTICATED" | "NO_WORKSPACE" | "NOT_FOUND" | "FORBIDDEN";
  message: string;
  /** Set on FORBIDDEN when a user lacked this permission. */
  permission?: Permission;
}

export interface SiteGrant {
  ok: true;
  workspaceId: string;
  siteId: string;
}

export interface WorkspaceGrant {
  ok: true;
  workspaceId: string;
  siteId?: undefined;
}

export type PolicyResult = SiteGrant | WorkspaceGrant | PolicyDenial;

/**
 * Scope for a list/search query, shaped to spread into the facility list
 * filters via {@link scopeFilter}: `siteIds` undefined means all sites,
 * `[]` is preserved so services stay fail-closed (empty result).
 */
export interface ListScope {
  ok: true;
  workspaceId: string;
  siteId?: string;
  siteIds?: string[];
}

export type ListPolicyResult = ListScope | PolicyDenial;

/** The list-filter fragment without the `ok` discriminant. */
export function scopeFilter(scope: ListScope): { workspaceId: string; siteId?: string; siteIds?: string[] } {
  const { ok: _ok, ...filter } = scope;
  return filter;
}

export interface PolicyDeps {
  hasPermission: typeof defaultHasPermission;
  getAccessibleSites: typeof defaultGetAccessibleSites;
  resolveSiteRef: typeof defaultResolveSiteRef;
}

/**
 * Overloaded so grants carry the scope precision the ref implies:
 * a site-bound ref always proves a siteId, a workspace ref never does.
 */
export interface AuthorizeFn {
  (
    iam: IAMContext | undefined,
    check: { permission: Permission; site: { kind: "workspace" } },
  ): Promise<WorkspaceGrant | PolicyDenial>;
  (
    iam: IAMContext | undefined,
    check: { permission: Permission; site: Exclude<SiteRef, { kind: "workspace" }> },
  ): Promise<SiteGrant | PolicyDenial>;
  (iam: IAMContext | undefined, check: { permission: Permission; site: SiteRef }): Promise<PolicyResult>;
}

const deny = (code: PolicyDenial["code"], message: string, permission?: Permission): PolicyDenial => ({
  ok: false,
  code,
  message,
  ...(permission ? { permission } : {}),
});

interface AuthenticatedContext {
  ok: true;
  workspaceId: string;
  iam: IAMContext;
}

/**
 * Shared entry guards: valid token, known principal, workspace context.
 * Pure context checks — no queries.
 */
function requireAuthenticated(iam: IAMContext | undefined): AuthenticatedContext | PolicyDenial {
  if (!iam?.validToken) {
    return deny("UNAUTHENTICATED", "Authentication required");
  }
  if (iam.principal !== Principal.USER && iam.principal !== Principal.DISPLAY && iam.principal !== Principal.APP) {
    return deny("UNAUTHENTICATED", "Authentication required");
  }
  if (iam.principal === Principal.USER && !iam.id) {
    return deny("UNAUTHENTICATED", "Authentication required");
  }
  const workspaceId = iam.workspaceId;
  if (!workspaceId) {
    return deny("NO_WORKSPACE", "Workspace context required");
  }
  return { ok: true, workspaceId, iam };
}

/** Device principals (DISPLAY/APP) are authorized by their site binding. */
function deviceSiteGrant(iam: IAMContext, workspaceId: string, siteId: string): SiteGrant | PolicyDenial {
  if (iam.siteId !== siteId) {
    const message =
      iam.principal === Principal.DISPLAY
        ? "Display can only access resources in its site"
        : "Token not authorized for this site";
    return deny("FORBIDDEN", message);
  }
  return { ok: true, workspaceId, siteId };
}

export function createPolicy(deps: PolicyDeps) {
  // Prefer the per-request snapshot the auth plugin resolved (query-free);
  // fall back to a fresh DB load for callers without one.
  function userHasPermission(
    iam: IAMContext,
    permission: Permission,
    workspaceId: string,
    siteId?: string,
  ): Promise<boolean> | boolean {
    if (iam.permissionSnapshot) {
      return snapshotHasPermission(iam.permissionSnapshot, permission, siteId);
    }
    return deps.hasPermission(iam.id as string, permission, { workspaceId, ...(siteId ? { siteId } : {}) });
  }

  function userAccessibleSites(
    iam: IAMContext,
    permission: Permission,
    workspaceId: string,
  ): Promise<AccessibleSites> | AccessibleSites {
    if (iam.permissionSnapshot) {
      return snapshotAccessibleSites(iam.permissionSnapshot, permission);
    }
    return deps.getAccessibleSites(iam.id as string, permission, workspaceId);
  }

  async function authorize(
    iam: IAMContext | undefined,
    check: { permission: Permission; site: SiteRef },
  ): Promise<PolicyResult> {
    const auth = requireAuthenticated(iam);
    if (!auth.ok) return auth;
    const { workspaceId } = auth;
    const principal = auth.iam.principal;

    if (check.site.kind === "workspace") {
      if (principal !== Principal.USER) {
        return deny("FORBIDDEN", "Workspace-level actions require a user account");
      }
      const ok = await userHasPermission(auth.iam, check.permission, workspaceId);
      if (!ok) {
        return deny("FORBIDDEN", `Missing permission: ${check.permission}`, check.permission);
      }
      return { ok: true, workspaceId };
    }

    // Resolve the target site. Literal ids need no query; resource refs are
    // a single indexed read of the denormalized siteId column, and run
    // BEFORE any permission query so nonexistent ids short-circuit.
    let siteId: string;
    if (check.site.kind === "site") {
      siteId = check.site.siteId;
    } else {
      const resolved = await deps.resolveSiteRef(check.site);
      if (!resolved) {
        return deny("NOT_FOUND", NOT_FOUND_MESSAGES[check.site.kind]);
      }
      siteId = resolved.siteId;
    }

    if (principal !== Principal.USER) {
      return deviceSiteGrant(auth.iam, workspaceId, siteId);
    }

    const ok = await userHasPermission(auth.iam, check.permission, workspaceId, siteId);
    if (!ok) {
      return deny("FORBIDDEN", `Missing permission: ${check.permission}`, check.permission);
    }
    return { ok: true, workspaceId, siteId };
  }

  async function authorizeList(
    iam: IAMContext | undefined,
    check: { permission: Permission; requestedSiteId?: string },
  ): Promise<ListPolicyResult> {
    const auth = requireAuthenticated(iam);
    if (!auth.ok) return auth;
    const { workspaceId } = auth;

    if (auth.iam.principal !== Principal.USER) {
      // Device principals always list within their own site.
      const ownSiteId = auth.iam.siteId;
      if (!ownSiteId) {
        return deny("NO_WORKSPACE", "Site context required");
      }
      if (check.requestedSiteId && check.requestedSiteId !== ownSiteId) {
        const message =
          auth.iam.principal === Principal.DISPLAY
            ? "Display can only access resources in its site"
            : "Token not authorized for this site";
        return deny("FORBIDDEN", message);
      }
      return { ok: true, workspaceId, siteId: ownSiteId };
    }

    const access = await userAccessibleSites(auth.iam, check.permission, workspaceId);
    if (check.requestedSiteId) {
      if (!access.all && !access.siteIds.includes(check.requestedSiteId)) {
        return deny("FORBIDDEN", `Missing permission: ${check.permission}`, check.permission);
      }
      return { ok: true, workspaceId, siteId: check.requestedSiteId };
    }
    if (access.all) {
      return { ok: true, workspaceId };
    }
    return { ok: true, workspaceId, siteIds: access.siteIds };
  }

  return { authorize: authorize as AuthorizeFn, authorizeList };
}

const NOT_FOUND_MESSAGES: Record<ResolvableSiteRef["kind"], string> = {
  station: "Station not found",
  workcenter: "Workcenter not found",
  stationStateLog: "State log entry not found",
};

const defaultPolicy = createPolicy({
  hasPermission: defaultHasPermission,
  getAccessibleSites: defaultGetAccessibleSites,
  resolveSiteRef: defaultResolveSiteRef,
});

export const authorize = defaultPolicy.authorize;
export const authorizeList = defaultPolicy.authorizeList;
export type { Permission, ResolvableSiteRef };

import { type IAMContext, Principal } from "../context.js";
import {
  type AccessibleSites,
  getAccessibleSites as defaultGetAccessibleSites,
  hasPermission as defaultHasPermission,
  type Permission,
  snapshotAccessibleSites,
  snapshotHasPermission,
} from "./permissions.js";
import {
  type NullableSiteKind,
  resolveSiteRef as defaultResolveSiteRef,
  type ResolvableKind,
  type ResolvableSiteRef,
} from "./policy-resolvers.js";

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

/**
 * The scope a permission is authorized against: a literal site, the whole
 * workspace, "any granted site", or a resource whose site lineage the policy
 * resolves. authorize(permission, scope) produces a verified grant — or a
 * typed denial.
 */
export type ScopeRef =
  | { kind: "workspace" } // workspace-level action (e.g. site.create)
  | { kind: "anySite" } // grant if permission held workspace-wide or at >=1 site
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
 * Scope for a list/search query. Single-site by design: users work within
 * one site at a time (the token's active site, or an explicitly requested
 * site they hold the permission at). Cross-site listing exists only through
 * {@link SiteDirectoryScope} for the site directory.
 */
export interface ListScope {
  ok: true;
  workspaceId: string;
  siteId: string;
}

export type ListPolicyResult = ListScope | PolicyDenial;

/**
 * The ONE sanctioned multi-site shape: which sites may this user see in the
 * site directory (site picker / site administration). `siteIds` undefined
 * means all sites in the workspace. Do not use for domain lists — those are
 * single-site via {@link ListScope}.
 */
export interface SiteDirectoryScope {
  ok: true;
  workspaceId: string;
  siteIds?: string[];
}

/** The list-filter fragment without the `ok` discriminant. */
export function scopeFilter(scope: ListScope): { workspaceId: string; siteId: string } {
  return { workspaceId: scope.workspaceId, siteId: scope.siteId };
}

/**
 * Prisma-shaped site predicate for handler-level direct-Prisma reads
 * (ADR-0002 amendment). Merge into `AND` — a plain spread can be clobbered
 * by later `where.siteId` assignments.
 */
export function scopeWhere(scope: ListScope): { siteId: string } {
  return { siteId: scope.siteId };
}

export interface PolicyDeps {
  hasPermission: typeof defaultHasPermission;
  getAccessibleSites: typeof defaultGetAccessibleSites;
  resolveSiteRef: typeof defaultResolveSiteRef;
}

/**
 * Overloaded so grants carry the scope precision the ref implies:
 * a literal site ref always proves a siteId; workspace/anySite refs never
 * do; resolvable refs may yield a workspace grant (null-site rows).
 */
export interface AuthorizeFn {
  (
    iam: IAMContext | undefined,
    check: { permission: Permission; scope: { kind: "workspace" } | { kind: "anySite" } },
  ): Promise<WorkspaceGrant | PolicyDenial>;
  (
    iam: IAMContext | undefined,
    check: { permission: Permission; scope: { kind: "site"; siteId: string } },
  ): Promise<SiteGrant | PolicyDenial>;
  (
    iam: IAMContext | undefined,
    check: { permission: Permission; scope: { kind: NullableSiteKind; id: string } },
  ): Promise<SiteGrant | WorkspaceGrant | PolicyDenial>;
  (
    iam: IAMContext | undefined,
    check: { permission: Permission; scope: { kind: Exclude<ResolvableKind, NullableSiteKind>; id: string } },
  ): Promise<SiteGrant | PolicyDenial>;
  (iam: IAMContext | undefined, check: { permission: Permission; scope: ScopeRef }): Promise<PolicyResult>;
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

  /** Permission held workspace-wide or at >=1 site (query-free w/ snapshot). */
  async function userHasAnySitePermission(iam: IAMContext, permission: Permission, workspaceId: string) {
    const access = await userAccessibleSites(iam, permission, workspaceId);
    return access.all || access.siteIds.length > 0;
  }

  async function anySiteGrant(
    iam: IAMContext,
    permission: Permission,
    workspaceId: string,
  ): Promise<WorkspaceGrant | PolicyDenial> {
    // Devices are site-bound; anySite grants workspace-breadth access
    // (events streams, null-site resources) which only user roles express.
    if (iam.principal !== Principal.USER) {
      return deny("FORBIDDEN", "This action requires a user account");
    }
    if (!(await userHasAnySitePermission(iam, permission, workspaceId))) {
      return deny("FORBIDDEN", `Missing permission: ${permission}`, permission);
    }
    return { ok: true, workspaceId };
  }

  async function authorize(
    iam: IAMContext | undefined,
    check: { permission: Permission; scope: ScopeRef },
  ): Promise<PolicyResult> {
    const auth = requireAuthenticated(iam);
    if (!auth.ok) return auth;
    const { workspaceId } = auth;
    const principal = auth.iam.principal;

    if (check.scope.kind === "workspace") {
      if (principal !== Principal.USER) {
        return deny("FORBIDDEN", "Workspace-level actions require a user account");
      }
      const ok = await userHasPermission(auth.iam, check.permission, workspaceId);
      if (!ok) {
        return deny("FORBIDDEN", `Missing permission: ${check.permission}`, check.permission);
      }
      return { ok: true, workspaceId };
    }

    if (check.scope.kind === "anySite") {
      return anySiteGrant(auth.iam, check.permission, workspaceId);
    }

    // Resolve the target site. Literal ids need no query; resource refs are
    // a narrow read of the denormalized siteId column (or one required-
    // parent hop), and run BEFORE any permission query so nonexistent ids
    // short-circuit.
    let siteId: string;
    if (check.scope.kind === "site") {
      siteId = check.scope.siteId;
    } else {
      const resolved = await deps.resolveSiteRef(check.scope);
      if (!resolved) {
        return deny("NOT_FOUND", NOT_FOUND_MESSAGES[check.scope.kind]);
      }
      if (resolved.siteId === null) {
        // Row exists but is not attached to a site (unassigned device,
        // workspace-level document, global schema): anySite rule.
        return anySiteGrant(auth.iam, check.permission, workspaceId);
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

    // Single-site rule: an explicit request wins; otherwise the token's
    // active site (bound at login / switch-site) is the query context.
    const siteId = check.requestedSiteId ?? auth.iam.siteId;
    if (!siteId) {
      return deny("NO_WORKSPACE", "Site context required");
    }
    const ok = await userHasPermission(auth.iam, check.permission, workspaceId, siteId);
    if (!ok) {
      return deny("FORBIDDEN", `Missing permission: ${check.permission}`, check.permission);
    }
    return { ok: true, workspaceId, siteId };
  }

  /**
   * Site-directory scope: the accessible-site set for the site picker and
   * site administration ONLY. Every other list is single-site.
   */
  async function authorizeAccessibleSites(
    iam: IAMContext | undefined,
    check: { permission: Permission },
  ): Promise<SiteDirectoryScope | PolicyDenial> {
    const auth = requireAuthenticated(iam);
    if (!auth.ok) return auth;
    const { workspaceId } = auth;

    if (auth.iam.principal !== Principal.USER) {
      const ownSiteId = auth.iam.siteId;
      if (!ownSiteId) {
        return deny("NO_WORKSPACE", "Site context required");
      }
      return { ok: true, workspaceId, siteIds: [ownSiteId] };
    }

    const access = await userAccessibleSites(auth.iam, check.permission, workspaceId);
    if (access.all) {
      return { ok: true, workspaceId };
    }
    return { ok: true, workspaceId, siteIds: access.siteIds };
  }

  return { authorize: authorize as AuthorizeFn, authorizeList, authorizeAccessibleSites };
}

const NOT_FOUND_MESSAGES: Record<ResolvableSiteRef["kind"], string> = {
  station: "Station not found",
  workcenter: "Workcenter not found",
  label: "Label not found",
  stationStateLog: "State log entry not found",
  order: "Order not found",
  orderLineItem: "Order line item not found",
  customer: "Customer not found",
  statusReason: "Status reason not found",
  statusCategory: "Status category not found",
  call: "Call not found",
  callDefinition: "Call definition not found",
  disposition: "Disposition not found",
  dispositionReason: "Disposition reason not found",
  dispositionLog: "Disposition log not found",
  tool: "Tool not found",
  toolCavity: "Tool cavity not found",
  job: "Job not found",
  jobProduct: "Job item not found",
  product: "Product not found",
  productMaterial: "Product material not found",
  productAltGroup: "Alternative group not found",
  productPicture: "Product picture not found",
  material: "Material not found",
  inventoryItem: "Inventory item not found",
  dashboard: "Dashboard not found",
  savedView: "Saved view not found",
  shiftPattern: "Shift pattern not found",
  shiftDefinition: "Shift definition not found",
  shiftAssignment: "Shift assignment not found",
  shiftComment: "Shift comment not found",
  employeeRole: "Employee role not found",
  cycle: "Cycle not found",
  graphNode: "Graph node not found",
  graphNodeType: "Graph node type not found",
  graphTypeField: "Graph type field not found",
  graphTypeInput: "Graph type input not found",
  graphTypeFacet: "Graph type facet not found",
  graphProperty: "Graph property not found",
  graphHook: "Graph hook not found",
  integration: "Integration not found",
  integrationTrigger: "Integration trigger not found",
  siteAndonRule: "Andon rule not found",
  gateway: "Gateway not found",
  datasource: "Datasource not found",
  display: "Display not found",
  document: "Document not found",
  objectSchema: "Schema not found",
  objectInstance: "Instance not found",
  point: "Point not found",
  pointGroup: "Point group not found",
};

const defaultPolicy = createPolicy({
  hasPermission: defaultHasPermission,
  getAccessibleSites: defaultGetAccessibleSites,
  resolveSiteRef: defaultResolveSiteRef,
});

export const authorize = defaultPolicy.authorize;
export const authorizeList = defaultPolicy.authorizeList;
export const authorizeAccessibleSites = defaultPolicy.authorizeAccessibleSites;
export type { Permission, ResolvableSiteRef };

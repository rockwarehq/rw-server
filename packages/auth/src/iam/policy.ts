import { type IAMContext, Principal } from "../context.js";
import {
  type BucketSnapshot,
  type BucketTier,
  loadBucketSnapshot as defaultLoadBucketSnapshot,
  snapshotPlantTier,
  snapshotVisibleSites,
  snapshotWorkcenterIds,
  snapshotWorkcenterTier,
  tierAtLeast,
} from "./buckets.js";
import {
  type NullableSiteKind,
  resolveSiteRef as defaultResolveSiteRef,
  type ResolvableKind,
  type ResolvableSiteRef,
} from "./policy-resolvers.js";

// ── Centralized authorization decisions ──────────────────────────────────
// One call per protected operation: the caller declares the REQUIRED TIER
// and where the row lives; the policy resolves the row to its bucket
// (workcenter-stamped rows → that cell's bucket; everything else → the
// site's plant bucket) and answers from the request's bucket snapshot.
// Never throws — transports map PolicyDenial to their own wire errors
// (rpc/authz.ts, api/authz.ts in the API app), consistent with ADR-0003.
//
// Deployments run a single workspace, so the policy enforces tier and
// SITE-level scope only; it does not verify workspace containment of
// resources (vacuously true) and adds no queries for it.

/**
 * The scope a tier is authorized against: a literal site, the whole
 * workspace, "any granted site", or a resource whose lineage the policy
 * resolves. authorize(tier, scope) produces a verified grant — or a typed
 * denial.
 */
export type ScopeRef =
  | { kind: "workspace" } // ownership-level action (e.g. workspace.delete)
  | { kind: "anySite" } // reads: any visible site; writes: owners only
  // Literal ids from input/params. workcenterId routes the check to that
  // cell's bucket (create flows target a workcenter before the row
  // exists); spoofing is safe because the tier must be held at BOTH the
  // claimed pair, and a workcenter belongs to exactly one site.
  | { kind: "site"; siteId: string; workcenterId?: string }
  | ResolvableSiteRef; // derived from a resource id via a narrow lookup

export interface PolicyDenial {
  ok: false;
  code: "UNAUTHENTICATED" | "NO_WORKSPACE" | "NOT_FOUND" | "FORBIDDEN";
  message: string;
  /** Set on FORBIDDEN when a user lacked this tier. */
  tier?: BucketTier;
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
 * site they hold the tier at). Cross-site listing exists only through
 * {@link SiteDirectoryScope} for the site directory.
 */
export interface ListScope {
  ok: true;
  workspaceId: string;
  siteId: string;
  /**
   * Set when access comes only from workcenter buckets: rows must belong
   * to these workcenters — or carry no workcenter at all, which stays
   * readable (site-level rows are plant things, and any crew member is a
   * plant member). Handlers for workcenter-bound resources merge
   * {@link scopeWorkcenterWhere}; handlers for plant resources ignore it.
   */
  workcenterIds?: string[];
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

/**
 * Prisma fragment narrowing a workcenter-bound list to the scope's crew
 * buckets. Site-level rows (workcenterId null) stay readable — they are
 * plant things, and every crew member is a plant member. Merge into `AND`
 * next to {@link scopeWhere}.
 */
export function scopeWorkcenterWhere(
  scope: ListScope,
): { OR: Array<{ workcenterId: { in: string[] } } | { workcenterId: null }> } | Record<string, never> {
  return scope.workcenterIds ? { OR: [{ workcenterId: { in: scope.workcenterIds } }, { workcenterId: null }] } : {};
}

export interface PolicyDeps {
  loadBucketSnapshot: typeof defaultLoadBucketSnapshot;
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
    check: { tier: BucketTier; scope: { kind: "workspace" } | { kind: "anySite" }; ownerOnly?: boolean },
  ): Promise<WorkspaceGrant | PolicyDenial>;
  (
    iam: IAMContext | undefined,
    check: { tier: BucketTier; scope: { kind: "site"; siteId: string; workcenterId?: string } },
  ): Promise<SiteGrant | PolicyDenial>;
  (
    iam: IAMContext | undefined,
    check: { tier: BucketTier; scope: { kind: NullableSiteKind; id: string } },
  ): Promise<SiteGrant | WorkspaceGrant | PolicyDenial>;
  (
    iam: IAMContext | undefined,
    check: { tier: BucketTier; scope: { kind: Exclude<ResolvableKind, NullableSiteKind>; id: string } },
  ): Promise<SiteGrant | PolicyDenial>;
  (
    iam: IAMContext | undefined,
    check: { tier: BucketTier; scope: ScopeRef; ownerOnly?: boolean },
  ): Promise<PolicyResult>;
}

const deny = (code: PolicyDenial["code"], message: string, tier?: BucketTier): PolicyDenial => ({
  ok: false,
  code,
  message,
  ...(tier ? { tier } : {}),
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

/**
 * Device principals (DISPLAY/APP) are authorized by their site binding —
 * simple auth layers, deliberately outside the bucket model.
 */
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
  async function userSnapshot(iam: IAMContext, workspaceId: string): Promise<BucketSnapshot | null> {
    if (iam.bucketSnapshot) return iam.bucketSnapshot as BucketSnapshot;
    return deps.loadBucketSnapshot(iam.id as string, workspaceId);
  }

  /** Bypass evaluation shared by every user path. */
  function bypassTier(snapshot: BucketSnapshot, tier: BucketTier): boolean {
    if (snapshot.owner) return true;
    if (snapshot.staff === "FULL") return true;
    if (snapshot.staff === "READ" && tier === "VIEW") return true;
    return false;
  }

  async function authorize(
    iam: IAMContext | undefined,
    check: { tier: BucketTier; scope: ScopeRef; ownerOnly?: boolean },
  ): Promise<PolicyResult> {
    const auth = requireAuthenticated(iam);
    if (!auth.ok) return auth;
    const { workspaceId } = auth;
    const principal = auth.iam.principal;

    if (check.scope.kind === "workspace") {
      // Ownership-level actions: reserved for workspace owners (staff FULL
      // may act unless the call site marks the action ownerOnly).
      if (principal !== Principal.USER) {
        return deny("FORBIDDEN", "Workspace-level actions require a user account");
      }
      const snapshot = await userSnapshot(auth.iam, workspaceId);
      if (!snapshot) return deny("FORBIDDEN", "No workspace membership");
      const ok = snapshot.owner || (!check.ownerOnly && snapshot.staff === "FULL");
      if (!ok) {
        return deny("FORBIDDEN", "Reserved for the workspace owner", check.tier);
      }
      return { ok: true, workspaceId };
    }

    if (check.scope.kind === "anySite") {
      // Devices are site-bound; anySite grants workspace-breadth access
      // which only user accounts express.
      if (principal !== Principal.USER) {
        return deny("FORBIDDEN", "This action requires a user account");
      }
      const snapshot = await userSnapshot(auth.iam, workspaceId);
      if (!snapshot) return deny("FORBIDDEN", "No workspace membership");
      if (bypassTier(snapshot, check.tier)) return { ok: true, workspaceId };
      if (check.tier === "VIEW") {
        const visible = snapshotVisibleSites(snapshot);
        if (visible.all || visible.siteIds.length > 0) return { ok: true, workspaceId };
        return deny("FORBIDDEN", "No site access", check.tier);
      }
      // Held at any plant: a site's managers/admins act on site-independent
      // rows (unassigned pool hardware, cross-site rosters).
      const heldSomewhere = snapshot.entries.some((e) => e.kind === "PLANT" && tierAtLeast(e.tier, check.tier));
      if (heldSomewhere) return { ok: true, workspaceId };
      return deny("FORBIDDEN", `Requires ${check.tier} access at some plant`, check.tier);
    }

    // Resolve the target site (and, for workcenter-bound resources, the
    // workcenter). Literal ids need no query; resource refs are a narrow
    // read of the denormalized ownership columns and run BEFORE any
    // snapshot fallback query so nonexistent ids short-circuit.
    let siteId: string;
    let workcenterId: string | undefined;
    if (check.scope.kind === "site") {
      siteId = check.scope.siteId;
      workcenterId = check.scope.workcenterId;
    } else {
      const resolved = await deps.resolveSiteRef(check.scope);
      if (!resolved) {
        return deny("NOT_FOUND", NOT_FOUND_MESSAGES[check.scope.kind]);
      }
      if (resolved.siteId === null) {
        // Row exists but is attached to no site (unassigned device,
        // workspace-level document, global schema): reads follow the
        // anySite rule; changes are owner territory.
        return authorize(iam, { tier: check.tier, scope: { kind: "anySite" } });
      }
      siteId = resolved.siteId;
      workcenterId = resolved.workcenterId ?? undefined;
    }

    if (principal !== Principal.USER) {
      return deviceSiteGrant(auth.iam, workspaceId, siteId);
    }

    const snapshot = await userSnapshot(auth.iam, workspaceId);
    if (!snapshot) return deny("FORBIDDEN", "No workspace membership");
    if (bypassTier(snapshot, check.tier)) return { ok: true, workspaceId, siteId };

    // Workcenter-stamped rows live in that cell's bucket; everything else
    // is a plant thing. The cascade (plant MANAGE ⇒ cell MANAGE) is baked
    // into the snapshot, so one lookup answers both.
    const held = workcenterId ? snapshotWorkcenterTier(snapshot, workcenterId) : snapshotPlantTier(snapshot, siteId);
    if (!tierAtLeast(held, check.tier)) {
      return deny("FORBIDDEN", `Requires ${check.tier} access here`, check.tier);
    }
    return { ok: true, workspaceId, siteId };
  }

  async function authorizeList(
    iam: IAMContext | undefined,
    check: { tier: BucketTier; bucketKind: "PLANT" | "WORKCENTER"; requestedSiteId?: string },
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
    const snapshot = await userSnapshot(auth.iam, workspaceId);
    if (!snapshot) return deny("FORBIDDEN", "No workspace membership");
    if (bypassTier(snapshot, check.tier)) return { ok: true, workspaceId, siteId };

    if (check.bucketKind === "PLANT") {
      if (tierAtLeast(snapshotPlantTier(snapshot, siteId), check.tier)) {
        return { ok: true, workspaceId, siteId };
      }
      return deny("FORBIDDEN", `Requires ${check.tier} access here`, check.tier);
    }

    // WORKCENTER lists: plant managers see the whole floor; the crew sees
    // their own cells (site-level rows stay readable — see
    // scopeWorkcenterWhere).
    if (tierAtLeast(snapshotPlantTier(snapshot, siteId), "MANAGE")) {
      return { ok: true, workspaceId, siteId };
    }
    const workcenterIds = snapshotWorkcenterIds(snapshot, siteId, check.tier);
    if (workcenterIds.length > 0) {
      return { ok: true, workspaceId, siteId, workcenterIds };
    }
    return deny("FORBIDDEN", `Requires ${check.tier} access here`, check.tier);
  }

  /**
   * Site-directory scope: the visible-site set for the site picker and
   * site administration ONLY. Membership visibility — any bucket at a site
   * lists it. Every other list is single-site.
   */
  async function authorizeAccessibleSites(
    iam: IAMContext | undefined,
    _check: Record<string, never> = {},
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

    const snapshot = await userSnapshot(auth.iam, workspaceId);
    if (!snapshot) return { ok: true, workspaceId, siteIds: [] };
    const visible = snapshotVisibleSites(snapshot);
    if (visible.all) {
      return { ok: true, workspaceId };
    }
    return { ok: true, workspaceId, siteIds: visible.siteIds };
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
  productionMode: "Production mode not found",
  notificationGroup: "Notification group not found",
  notification: "Notification not found",
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
  automation: "Automation not found",
  point: "Point not found",
  pointGroup: "Point group not found",
};

const defaultPolicy = createPolicy({
  loadBucketSnapshot: defaultLoadBucketSnapshot,
  resolveSiteRef: defaultResolveSiteRef,
});

export const authorize = defaultPolicy.authorize;
export const authorizeList = defaultPolicy.authorizeList;
export const authorizeAccessibleSites = defaultPolicy.authorizeAccessibleSites;
export type { BucketTier, ResolvableSiteRef };

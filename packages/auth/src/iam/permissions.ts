import prisma from "@rw/db";
import type { SystemRole } from "@rw/db";

export const RESOURCES = [
  "facility", // sites, stations, workcenters, gateways, datasources, displays
  "schedule", // shift patterns, definitions, assignments, instances
  "job", // jobs, work orders, cycles, dispositions
  "status", // status reasons + categories (downtime taxonomy)
  "calls", // shop-floor call definitions + call lifecycle
  "modes", // production mode catalog + station force/clear
  "notifications", // notification groups + send/delivery log
  "tool", // tools
  "product", // products, materials, process types
  "dashboard", // dashboards (saved views)
  "entity", // user-defined object schemas and instances
  "graph", // graph nodes, properties, and dependency definitions
  "user", // workspace users + memberships
  "employee", // employee roster (shop-floor identities)
  "billing", // invoices, payment method, subscription, plan changes
  "settings", // general workspace config + ownership transfer
] as const;

export const ACTIONS = ["read", "write", "admin"] as const;
export const OWNER_PERMISSION = "owner:all" as const;
export const RESERVED_PERMISSIONS = [OWNER_PERMISSION] as const;

export type Resource = (typeof RESOURCES)[number];
export type Action = (typeof ACTIONS)[number];
export type ReservedPermission = (typeof RESERVED_PERMISSIONS)[number];

// ── Customer permission catalog (target model) ──────────────────────────
// The catalog is shrinking to eight responsibility-based keys. During the
// transition BOTH vocabularies are valid: the legacy `resource:action`
// strings above stay in the Permission union (and role rows carry both key
// sets) until every call site checks the new keys, after which the legacy
// half of the union and the legacy data are removed together.

export const CUSTOMER_PERMISSIONS = [
  "production:read",
  "production:write",
  "production:admin",
  "planning:read",
  "planning:write",
  "configuration:read",
  "configuration:write",
  "plant:admin",
] as const;

export type CustomerPermission = (typeof CUSTOMER_PERMISSIONS)[number];
export type LegacyPermission = `${Resource}:${Action}`;
export type Permission = LegacyPermission | CustomerPermission | ReservedPermission;

export interface PermissionDefinition {
  label: string;
  description: string;
  implies?: readonly CustomerPermission[];
}

/** Shared metadata for authorization, role validation and role editors. */
export const PERMISSION_DEFINITIONS: Readonly<Record<CustomerPermission, PermissionDefinition>> = {
  "production:read": {
    label: "View production",
    description: "View production in the assigned scope and shared production references.",
  },
  "production:write": {
    label: "Manage production",
    description: "Manage operational work; plant scope also allows shared definitions and inventory changes.",
    implies: ["production:read"],
  },
  "production:admin": {
    label: "Administer production",
    description: "Manage production plus privileged production actions.",
    implies: ["production:write"],
  },
  "planning:read": {
    label: "View planning",
    description: "View orders, schedules, shift calendars and supporting production references.",
  },
  "planning:write": {
    label: "Manage planning",
    description: "Manage orders, customers, scheduling and shift calendars.",
    implies: ["planning:read"],
  },
  "configuration:read": {
    label: "View technical setup",
    description: "View equipment, dashboards, data configuration, integrations and automation configuration.",
  },
  "configuration:write": {
    label: "Manage technical setup",
    description: "Configure equipment, dashboards, data models, integrations and automations.",
    implies: ["configuration:read"],
  },
  "plant:admin": {
    label: "Administer plant",
    description: "Manage account access, employee profiles and administrative settings in the assigned scope.",
  },
};

/**
 * Close a permission set over `implies`: write implies read, production
 * admin implies write (and read, transitively). Applied only AFTER a
 * grant's exact scope is selected, so implication can never widen scope.
 * plant:admin and owner:all imply nothing — they are independent
 * capabilities, not wildcards. Legacy keys have no implications.
 */
export function expandPermissions(input: Iterable<string>): Set<Permission> {
  const out = new Set<Permission>();
  for (const p of input) {
    if (isPermission(p)) out.add(p);
  }
  // Set iteration also visits members added during the loop, so the
  // admin → write → read chain closes in one pass.
  for (const permission of out) {
    const implied = PERMISSION_DEFINITIONS[permission as CustomerPermission]?.implies;
    if (implied) for (const p of implied) out.add(p);
  }
  return out;
}

export const ALL_PERMISSIONS: Permission[] = [
  ...RESOURCES.flatMap((r) => ACTIONS.map((a) => `${r}:${a}` as Permission)),
  ...CUSTOMER_PERMISSIONS,
  ...RESERVED_PERMISSIONS,
];

const ALL_PERMISSIONS_SET: ReadonlySet<Permission> = new Set(ALL_PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return ALL_PERMISSIONS_SET.has(value as Permission);
}

export function hasOwnerPermission(permissions: readonly string[]): boolean {
  return permissions.includes(OWNER_PERMISSION);
}

/**
 * Validate a list of permission strings. Throws on any invalid entry.
 * Used when creating or updating custom roles from user input.
 */
export function validatePermissions(input: readonly string[]): Permission[] {
  const invalid = input.filter((p) => !ALL_PERMISSIONS_SET.has(p as Permission));
  if (invalid.length) {
    throw new Error(`Invalid permissions: ${invalid.join(", ")}`);
  }
  return input as Permission[];
}

// ── System-role permissions (Rockware-internal staff) ────────────────────
// Permissions for system users live in code, not in the database. Customers
// cannot influence these; Rockware cannot grant them through the product UI.

export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRole, ReadonlySet<Permission>> = {
  SUPPORT: new Set(ALL_PERMISSIONS.filter((p) => p.endsWith(":read") && !p.startsWith("billing:"))),
  ENGINEER: new Set(ALL_PERMISSIONS.filter((p) => p !== OWNER_PERMISSION)),
};

// ── Workcenter grants ────────────────────────────────────────────────────
// GitHub-collaborator model: a WorkcenterGrant row gives a membership READ
// or WRITE at one workcenter, independent of (and unioned with) any site
// role. Site roles dominate for free: their permissions apply at every
// workcenter, so max(site role, grant) is just set-union.

export type WorkcenterAccessLevel = "READ" | "WRITE";

// A grant confers these SITE-WIDE — data that is global in nature (jobs,
// schedules, tools…), which anyone working a workcenter needs to see and,
// with WRITE, update. Employee stays read-only even for WRITE.
const WC_READ_GLOBAL: readonly Permission[] = [
  "facility:read",
  "job:read",
  "schedule:read",
  "tool:read",
  "product:read",
  "entity:read",
  "graph:read",
  "dashboard:read",
  "employee:read",
];

// No new-vocabulary keys here on purpose: in the target model a workcenter
// grant confers production access only, so the legacy global reads/writes
// below simply disappear at the contract step instead of being renamed.
export const WC_GRANT_GLOBAL_PERMISSIONS: Record<WorkcenterAccessLevel, readonly Permission[]> = {
  READ: WC_READ_GLOBAL,
  WRITE: [
    ...WC_READ_GLOBAL,
    "job:write",
    "schedule:write",
    "tool:write",
    "product:write",
    "entity:write",
    "graph:write",
    "dashboard:write",
  ],
};

// A grant confers these ONLY at the granted workcenter — status, calls,
// production modes (force/clear act on stations), and facility config
// (stations, workcenter setup) are the workcenter's own.
// settings/user/billing/notifications appear in neither map: those stay
// with plant admins.
export const WC_GRANT_SCOPED_PERMISSIONS: Record<WorkcenterAccessLevel, readonly Permission[]> = {
  READ: ["status:read", "calls:read", "modes:read", "production:read"],
  WRITE: [
    "status:read",
    "status:write",
    "calls:read",
    "calls:write",
    "modes:read",
    "modes:write",
    "facility:write",
    "production:read",
    "production:write",
  ],
};

function workcenterAccessPermissions(access: string): {
  global: readonly Permission[];
  scoped: readonly Permission[];
} {
  const level = access as WorkcenterAccessLevel;
  return {
    global: WC_GRANT_GLOBAL_PERMISSIONS[level] ?? [],
    scoped: WC_GRANT_SCOPED_PERMISSIONS[level] ?? [],
  };
}

// ── Base workcenter access policy ────────────────────────────────────────
// GitHub's org "base permissions" at plant scope: a per-site setting (stored
// in Site.attrs) deciding whether read-tier site roles see the live floor
// (status/calls) site-wide (ALL — the default) or only at explicitly
// granted workcenters (GRANTS_REQUIRED). Management-tier roles — anything
// carrying status:write — are exempt; WORKSPACE-scope roles are exempt by
// their null siteId. facility:read is deliberately NOT in the floor set:
// the directory (workcenter/station names, site entry) stays visible; it is
// the live floor data that the policy gates.

export const BASE_WORKCENTER_ACCESS_KEY = "baseWorkcenterAccess" as const;
export type BaseWorkcenterAccess = "ALL" | "GRANTS_REQUIRED";

// production:read is the new-vocabulary floor read; production:write/admin
// mark management tier the way status:write does for legacy arrays. The
// floor is dropped from the RAW role array BEFORE implication expansion, so
// a stripped role cannot imply its way back to floor visibility (exempt
// roles are never stripped in the first place).
const POLICY_FLOOR_PERMISSIONS: ReadonlySet<Permission> = new Set([
  "status:read",
  "calls:read",
  "modes:read",
  "production:read",
]);
const POLICY_EXEMPT_MARKERS: ReadonlySet<string> = new Set(["status:write", "production:write", "production:admin"]);

function assignmentDropsFloor(
  assignment: { siteId: string | null; permissions: string[] },
  grantsRequired: ReadonlySet<string>,
): boolean {
  return (
    assignment.siteId !== null &&
    grantsRequired.has(assignment.siteId) &&
    !assignment.permissions.some((p) => POLICY_EXEMPT_MARKERS.has(p))
  );
}

/**
 * The permission set ONE role assignment contributes: validate the raw
 * strings, apply the floor drop, then close over implications. Every
 * evaluation path (snapshot and fresh-load alike) funnels through here.
 *
 * A role row may hold legacy keys, new keys, or both during the transition;
 * each string is evaluated literally — there is no mapping between the two
 * vocabularies at runtime. The expand/contract data migrations own that
 * translation.
 */
function effectiveAssignmentPermissions(permissions: readonly string[], dropFloor: boolean): Set<Permission> {
  const held: string[] = [];
  for (const p of permissions) {
    if (!ALL_PERMISSIONS_SET.has(p as Permission)) continue;
    if (dropFloor && POLICY_FLOOR_PERMISSIONS.has(p as Permission)) continue;
    held.push(p);
  }
  return expandPermissions(held);
}

// ── Permission checks ────────────────────────────────────────────────────

export interface PermissionContext {
  workspaceId: string;
  siteId?: string;
  workcenterId?: string;
}

export type AccessibleSites = { all: true } | { all: false; siteIds: string[] };

export interface AccessibleSiteRef {
  id: string;
  name: string;
}

// ── Permission snapshot ──────────────────────────────────────────────────
// One (systemRole, assignments) load per (user, workspace) feeds every
// evaluation. The auth plugin resolves a snapshot once per request and hangs
// it on the IAM context so downstream policy checks are query-free; the
// DB-backed functions below load their own snapshot for callers without one.
// Structurally compatible with IAMContext.permissionSnapshot (no @rw/db
// types) so it can cross the context boundary.

export interface PermissionSnapshot {
  systemRole: string | null;
  assignments: Array<{ siteId: string | null; permissions: string[] }>;
  workcenterGrants?: Array<{ workcenterId: string; siteId: string; access: string }>;
  /**
   * Sites whose baseWorkcenterAccess policy is GRANTS_REQUIRED. Absent or
   * empty means ALL everywhere (legacy snapshots fail open to today's
   * behavior through rolling deploys).
   */
  grantsRequiredSiteIds?: string[];
}

/** Load the snapshot for a user's membership. Null when the user is missing. */
export async function loadPermissionSnapshot(userId: string, workspaceId: string): Promise<PermissionSnapshot | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { systemRole: true },
  });

  if (!user) return null;

  if (user.systemRole) {
    return { systemRole: user.systemRole, assignments: [] };
  }

  const [assignments, grants, policySites] = await Promise.all([
    prisma.roleAssignment.findMany({
      where: { membership: { userId, workspaceId } },
      select: { siteId: true, role: { select: { permissions: true } } },
    }),
    prisma.workcenterGrant.findMany({
      where: { membership: { userId, workspaceId } },
      select: { workcenterId: true, access: true, workcenter: { select: { siteId: true } } },
    }),
    prisma.site.findMany({
      where: { workspaceId, attrs: { path: [BASE_WORKCENTER_ACCESS_KEY], equals: "GRANTS_REQUIRED" } },
      select: { id: true },
    }),
  ]);

  return {
    systemRole: null,
    assignments: assignments.map((a) => ({ siteId: a.siteId, permissions: a.role.permissions })),
    workcenterGrants: grants.map((g) => ({
      workcenterId: g.workcenterId,
      siteId: g.workcenter.siteId,
      access: g.access,
    })),
    grantsRequiredSiteIds: policySites.map((s) => s.id),
  };
}

function systemRolePermissions(systemRole: string): ReadonlySet<Permission> | undefined {
  return SYSTEM_ROLE_PERMISSIONS[systemRole as SystemRole];
}

/**
 * Pure evaluation of the permission set a snapshot grants at a context.
 *
 * - System users resolve from SYSTEM_ROLE_PERMISSIONS.
 * - Customer users union all workspace-level assignments plus site-scoped
 *   assignments matching `siteId`. Unknown permission strings are dropped.
 * - Workcenter grants at `siteId` add their global permissions site-wide;
 *   their workcenter-scoped permissions only when `workcenterId` matches
 *   the grant. Site roles dominate automatically via the union.
 */
export function snapshotEffectivePermissions(
  snapshot: PermissionSnapshot,
  siteId?: string,
  workcenterId?: string,
): Set<Permission> {
  if (snapshot.systemRole) {
    return new Set(systemRolePermissions(snapshot.systemRole) ?? []);
  }

  const out = new Set<Permission>();
  const grantsRequired = new Set(snapshot.grantsRequiredSiteIds ?? []);
  for (const assignment of snapshot.assignments) {
    if (assignment.siteId !== null && assignment.siteId !== siteId) continue;
    // GRANTS_REQUIRED sites strip the floor reads from read-tier site roles;
    // workcenter grants re-add them per workcenter in the loop below.
    const dropFloor = assignmentDropsFloor(assignment, grantsRequired);
    for (const p of effectiveAssignmentPermissions(assignment.permissions, dropFloor)) {
      out.add(p);
    }
  }
  for (const grantRow of snapshot.workcenterGrants ?? []) {
    if (!siteId || grantRow.siteId !== siteId) continue;
    const { global, scoped } = workcenterAccessPermissions(grantRow.access);
    for (const p of global) out.add(p);
    if (workcenterId && grantRow.workcenterId === workcenterId) {
      for (const p of scoped) out.add(p);
    }
  }
  return out;
}

export function snapshotHasPermission(
  snapshot: PermissionSnapshot,
  permission: Permission,
  siteId?: string,
  workcenterId?: string,
): boolean {
  return snapshotEffectivePermissions(snapshot, siteId, workcenterId).has(permission);
}

/**
 * Pure evaluation of which sites a snapshot grants `permission` at.
 * Workcenter-scoped grant permissions count as held at the grant's site
 * (anySite semantics: held at ≥1 workcenter there).
 */
export function snapshotAccessibleSites(snapshot: PermissionSnapshot, permission: Permission): AccessibleSites {
  if (snapshot.systemRole) {
    return systemRolePermissions(snapshot.systemRole)?.has(permission) ? { all: true } : { all: false, siteIds: [] };
  }

  const siteIds = new Set<string>();
  const grantsRequired = new Set(snapshot.grantsRequiredSiteIds ?? []);
  for (const assignment of snapshot.assignments) {
    // Evaluating the EFFECTIVE per-assignment set keeps "held at X" ⇔ "X
    // accessible" consistent everywhere: floor perms stripped by
    // GRANTS_REQUIRED don't make the site accessible (grants below still
    // add their sites), while implied keys do.
    const dropFloor = assignmentDropsFloor(assignment, grantsRequired);
    if (!effectiveAssignmentPermissions(assignment.permissions, dropFloor).has(permission)) continue;
    if (assignment.siteId === null) return { all: true };
    siteIds.add(assignment.siteId);
  }
  for (const grantRow of snapshot.workcenterGrants ?? []) {
    const { global, scoped } = workcenterAccessPermissions(grantRow.access);
    if (global.includes(permission) || scoped.includes(permission)) {
      siteIds.add(grantRow.siteId);
    }
  }

  return { all: false, siteIds: [...siteIds] };
}

/**
 * Sites where the snapshot holds ANY access at all — membership visibility
 * for the site directory and token site claims. Decoupled from any single
 * permission on purpose: as call sites migrate off the legacy keys, roles
 * stop being guaranteed to carry facility:read, but a role assignment (or a
 * workcenter grant) at a site should still make that site visible.
 */
export function snapshotVisibleSites(snapshot: PermissionSnapshot): AccessibleSites {
  if (snapshot.systemRole) {
    return systemRolePermissions(snapshot.systemRole) ? { all: true } : { all: false, siteIds: [] };
  }
  const siteIds = new Set<string>();
  for (const assignment of snapshot.assignments) {
    if (assignment.siteId === null) return { all: true };
    siteIds.add(assignment.siteId);
  }
  for (const grantRow of snapshot.workcenterGrants ?? []) {
    const { global, scoped } = workcenterAccessPermissions(grantRow.access);
    if (global.length || scoped.length) siteIds.add(grantRow.siteId);
  }
  return { all: false, siteIds: [...siteIds] };
}

/** Workcenters (at `siteId`) whose grants confer `permission` — scoped or global. */
export function snapshotWorkcentersWithPermission(
  snapshot: PermissionSnapshot,
  permission: Permission,
  siteId: string,
): string[] {
  const out = new Set<string>();
  for (const grantRow of snapshot.workcenterGrants ?? []) {
    if (grantRow.siteId !== siteId) continue;
    const { global, scoped } = workcenterAccessPermissions(grantRow.access);
    if (scoped.includes(permission) || global.includes(permission)) {
      out.add(grantRow.workcenterId);
    }
  }
  return [...out];
}

/**
 * Return the full set of permissions this user holds in the given context.
 * Loads a fresh snapshot; prefer the request's IAM snapshot where available.
 */
export async function getEffectivePermissions(userId: string, ctx: PermissionContext): Promise<Set<Permission>> {
  const snapshot = await loadPermissionSnapshot(userId, ctx.workspaceId);
  if (!snapshot) return new Set();
  return snapshotEffectivePermissions(snapshot, ctx.siteId, ctx.workcenterId);
}

export async function hasPermission(userId: string, permission: Permission, ctx: PermissionContext): Promise<boolean> {
  const perms = await getEffectivePermissions(userId, ctx);
  return perms.has(permission);
}

export async function hasAnyPermission(
  userId: string,
  permissions: readonly Permission[],
  ctx: PermissionContext,
): Promise<boolean> {
  const perms = await getEffectivePermissions(userId, ctx);
  return permissions.some((p) => perms.has(p));
}

export async function getAccessibleSites(
  userId: string,
  permission: Permission,
  workspaceId: string,
): Promise<AccessibleSites> {
  const snapshot = await loadPermissionSnapshot(userId, workspaceId);
  if (!snapshot) return { all: false, siteIds: [] };
  return snapshotAccessibleSites(snapshot, permission);
}

export async function getVisibleSites(userId: string, workspaceId: string): Promise<AccessibleSites> {
  const snapshot = await loadPermissionSnapshot(userId, workspaceId);
  if (!snapshot) return { all: false, siteIds: [] };
  return snapshotVisibleSites(snapshot);
}

/**
 * Without a permission this lists the user's VISIBLE sites (any assignment
 * or grant there); with one it lists sites holding that permission.
 */
export async function listAccessibleSites(
  userId: string,
  workspaceId: string,
  permission?: Permission,
): Promise<AccessibleSiteRef[]> {
  const access = permission
    ? await getAccessibleSites(userId, permission, workspaceId)
    : await getVisibleSites(userId, workspaceId);
  return prisma.site.findMany({
    where: {
      workspaceId,
      ...(access.all ? {} : { id: { in: access.siteIds } }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

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
export type Permission = `${Resource}:${Action}` | ReservedPermission;

export const ALL_PERMISSIONS: Permission[] = [
  ...RESOURCES.flatMap((r) => ACTIONS.map((a) => `${r}:${a}` as Permission)),
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

// A grant confers these ONLY at the granted workcenter — status, calls, and
// facility config (stations, workcenter setup) are the workcenter's own.
// settings/user/billing appear in neither map: those stay with plant admins.
export const WC_GRANT_SCOPED_PERMISSIONS: Record<WorkcenterAccessLevel, readonly Permission[]> = {
  READ: ["status:read", "calls:read"],
  WRITE: ["status:read", "status:write", "calls:read", "calls:write", "facility:write"],
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

  const [assignments, grants] = await Promise.all([
    prisma.roleAssignment.findMany({
      where: { membership: { userId, workspaceId } },
      select: { siteId: true, role: { select: { permissions: true } } },
    }),
    prisma.workcenterGrant.findMany({
      where: { membership: { userId, workspaceId } },
      select: { workcenterId: true, access: true, workcenter: { select: { siteId: true } } },
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
  for (const assignment of snapshot.assignments) {
    if (assignment.siteId !== null && assignment.siteId !== siteId) continue;
    for (const p of assignment.permissions) {
      if (ALL_PERMISSIONS_SET.has(p as Permission)) {
        out.add(p as Permission);
      }
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
  for (const assignment of snapshot.assignments) {
    if (!assignment.permissions.includes(permission)) continue;
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

export async function listAccessibleSites(
  userId: string,
  workspaceId: string,
  permission: Permission = "facility:read",
): Promise<AccessibleSiteRef[]> {
  const access = await getAccessibleSites(userId, permission, workspaceId);
  return prisma.site.findMany({
    where: {
      workspaceId,
      ...(access.all ? {} : { id: { in: access.siteIds } }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

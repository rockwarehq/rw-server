import prisma from "@rw/db";
import type { SystemRole } from "@rw/db";

export const RESOURCES = [
  "facility", // sites, stations, workcenters, gateways, datasources, displays
  "schedule", // shift patterns, definitions, assignments, instances
  "job", // jobs, work orders, cycles, dispositions
  "status", // status reasons + categories (downtime taxonomy)
  "calls", // shop-floor call definitions + call lifecycle
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

// ── Permission checks ────────────────────────────────────────────────────

export interface PermissionContext {
  workspaceId: string;
  siteId?: string;
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

  const assignments = await prisma.roleAssignment.findMany({
    where: { membership: { userId, workspaceId } },
    select: { siteId: true, role: { select: { permissions: true } } },
  });

  return {
    systemRole: null,
    assignments: assignments.map((a) => ({ siteId: a.siteId, permissions: a.role.permissions })),
  };
}

function systemRolePermissions(systemRole: string): ReadonlySet<Permission> | undefined {
  return SYSTEM_ROLE_PERMISSIONS[systemRole as SystemRole];
}

/**
 * Pure evaluation of the permission set a snapshot grants at a site context.
 *
 * - System users resolve from SYSTEM_ROLE_PERMISSIONS.
 * - Customer users union all workspace-level assignments plus site-scoped
 *   assignments matching `siteId`. Unknown permission strings are dropped.
 */
export function snapshotEffectivePermissions(snapshot: PermissionSnapshot, siteId?: string): Set<Permission> {
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
  return out;
}

export function snapshotHasPermission(snapshot: PermissionSnapshot, permission: Permission, siteId?: string): boolean {
  return snapshotEffectivePermissions(snapshot, siteId).has(permission);
}

/** Pure evaluation of which sites a snapshot grants `permission` at. */
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

  return { all: false, siteIds: [...siteIds] };
}

/**
 * Return the full set of permissions this user holds in the given context.
 * Loads a fresh snapshot; prefer the request's IAM snapshot where available.
 */
export async function getEffectivePermissions(userId: string, ctx: PermissionContext): Promise<Set<Permission>> {
  const snapshot = await loadPermissionSnapshot(userId, ctx.workspaceId);
  if (!snapshot) return new Set();
  return snapshotEffectivePermissions(snapshot, ctx.siteId);
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

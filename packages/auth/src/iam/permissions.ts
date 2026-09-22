import prisma from "@rw/db";
import type { SystemRole } from "@rw/db";

export const RESOURCES = ["production", "planning", "configuration", "plant"] as const;
export const ACTIONS = ["read", "write", "admin"] as const;
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
export const OWNER_PERMISSION = "owner:all" as const;
export const RESERVED_PERMISSIONS = [OWNER_PERMISSION] as const;
export type Resource = (typeof RESOURCES)[number];
export type Action = (typeof ACTIONS)[number];
export type ReservedPermission = (typeof RESERVED_PERMISSIONS)[number];
export type CustomerPermission = (typeof CUSTOMER_PERMISSIONS)[number];
export type Permission = CustomerPermission | ReservedPermission;
export const ALL_PERMISSIONS: Permission[] = [...CUSTOMER_PERMISSIONS, ...RESERVED_PERMISSIONS];
const ALL_PERMISSIONS_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export interface PermissionDefinition {
  label: string;
  description: string;
  scopes: readonly PermissionRoleScope[];
  implies?: readonly CustomerPermission[];
}

/** Shared metadata for authorization, custom-role validation and future role editors. */
export const PERMISSION_DEFINITIONS: Readonly<Record<CustomerPermission, PermissionDefinition>> = {
  "production:read": {
    label: "View production",
    description: "View production in the assigned scope and shared production references.",
    scopes: ["WORKSPACE", "SITE", "WORKCENTER"],
  },
  "production:write": {
    label: "Manage production",
    description: "Manage operational work; plant scope also allows shared definitions and inventory changes.",
    scopes: ["WORKSPACE", "SITE", "WORKCENTER"],
    implies: ["production:read"],
  },
  "production:admin": {
    label: "Administer production",
    description: "Manage production and privileged production actions, including comment deletion.",
    scopes: ["WORKSPACE", "SITE", "WORKCENTER"],
    implies: ["production:write"],
  },
  "planning:read": {
    label: "View planning",
    description: "View orders, schedules, shift calendars and supporting production references.",
    scopes: ["WORKSPACE", "SITE"],
  },
  "planning:write": {
    label: "Manage planning",
    description: "Manage orders, customers, scheduling and shift calendars.",
    scopes: ["WORKSPACE", "SITE"],
    implies: ["planning:read"],
  },
  "configuration:read": {
    label: "View technical setup",
    description: "View equipment, dashboards, data configuration, integrations and automation configuration.",
    scopes: ["WORKSPACE", "SITE"],
  },
  "configuration:write": {
    label: "Manage technical setup",
    description: "Configure equipment, dashboards, data models, integrations and automations.",
    scopes: ["WORKSPACE", "SITE"],
    implies: ["configuration:read"],
  },
  "plant:admin": {
    label: "Administer plant",
    description: "Manage account access, employee profiles and administrative settings in the assigned scope.",
    scopes: ["WORKSPACE", "SITE"],
  },
};

export function isPermission(value: string): value is Permission {
  return ALL_PERMISSIONS_SET.has(value);
}

export function hasOwnerPermission(permissions: readonly string[]): boolean {
  return permissions.includes(OWNER_PERMISSION);
}

export function validatePermissions(input: readonly string[]): Permission[] {
  const invalid = input.filter((p) => !isPermission(p));
  if (invalid.length) throw new Error(`Invalid permissions: ${invalid.join(", ")}`);
  return [...new Set(input)] as Permission[];
}

/** Implication is applied only after selecting a grant's exact scope. */
export function expandPermissions(input: readonly string[]): Set<Permission> {
  const out = new Set(input.filter(isPermission));
  // Set iteration also visits newly added implications, including admin -> write -> read.
  for (const permission of out) {
    if (permission === OWNER_PERMISSION) continue;
    for (const implied of PERMISSION_DEFINITIONS[permission].implies ?? []) out.add(implied);
  }
  // plant:admin and owner:all are independent capabilities, not wildcards.
  return out;
}

export type PermissionRoleScope = "WORKSPACE" | "SITE" | "WORKCENTER";

export function validateCustomRolePermissions(input: readonly string[], scope: PermissionRoleScope): Permission[] {
  const permissions = validatePermissions(input);
  if (permissions.includes(OWNER_PERMISSION)) throw new Error(`${OWNER_PERMISSION} is reserved for system roles`);
  if (permissions.some((p) => p !== OWNER_PERMISSION && !PERMISSION_DEFINITIONS[p].scopes.includes(scope))) {
    throw new Error("Workcenter-scoped roles may only contain production permissions");
  }
  return permissions;
}

export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRole, ReadonlySet<Permission>> = {
  SUPPORT: new Set(CUSTOMER_PERMISSIONS.filter((p) => p.endsWith(":read"))),
  ENGINEER: new Set(CUSTOMER_PERMISSIONS),
};

export type WorkcenterAccessLevel = "READ" | "WRITE";
export const WC_GRANT_SCOPED_PERMISSIONS: Record<WorkcenterAccessLevel, readonly Permission[]> = {
  READ: ["production:read"],
  WRITE: ["production:read", "production:write"],
};

/** @deprecated Workcenter grants never confer site-global permissions. */
export const WC_GRANT_GLOBAL_PERMISSIONS: Record<WorkcenterAccessLevel, readonly Permission[]> = {
  READ: [],
  WRITE: [],
};
/** @deprecated Retained for wire compatibility only; never evaluated. */
export const BASE_WORKCENTER_ACCESS_KEY = "baseWorkcenterAccess" as const;
/** @deprecated Retained for wire compatibility only; never evaluated. */
export type BaseWorkcenterAccess = "ALL" | "GRANTS_REQUIRED";

export interface PermissionContext {
  workspaceId: string;
  siteId?: string;
  workcenterId?: string;
}
export type AccessibleSites = { all: true } | { all: false; siteIds: string[] };
export type AccessibleWorkcenters = { all: true } | { all: false; workcenterIds: string[] };
export interface AccessibleSiteRef {
  id: string;
  name: string;
}
export interface PermissionSnapshot {
  systemRole: string | null;
  assignments: Array<{ siteId: string | null; workcenterId?: string | null; permissions: string[] }>;
  workcenterGrants?: Array<{ workcenterId: string; siteId: string; access: string }>;
  /** @deprecated Ignored, including in snapshots from older callers. */
  grantsRequiredSiteIds?: string[];
}

/** Load once per request; system staff resolve entirely from code. */
export async function loadPermissionSnapshot(userId: string, workspaceId: string): Promise<PermissionSnapshot | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { systemRole: true } });
  if (!user) return null;
  if (user.systemRole) return { systemRole: user.systemRole, assignments: [] };
  const [assignments, grants] = await Promise.all([
    prisma.roleAssignment.findMany({
      where: { membership: { userId, workspaceId } },
      select: { siteId: true, workcenterId: true, role: { select: { permissions: true } } },
    }),
    prisma.workcenterGrant.findMany({
      where: { membership: { userId, workspaceId } },
      select: { workcenterId: true, access: true, workcenter: { select: { siteId: true } } },
    }),
  ]);
  return {
    systemRole: null,
    assignments: assignments.map((a) => ({
      siteId: a.siteId,
      workcenterId: a.workcenterId,
      permissions: a.role.permissions,
    })),
    workcenterGrants: grants.map((g) => ({
      workcenterId: g.workcenterId,
      siteId: g.workcenter.siteId,
      access: g.access,
    })),
  };
}

function systemRolePermissions(systemRole: string): ReadonlySet<Permission> | undefined {
  return systemRole === "SUPPORT" || systemRole === "ENGINEER" ? SYSTEM_ROLE_PERMISSIONS[systemRole] : undefined;
}

function grantPermissions(access: string): readonly Permission[] {
  return access === "READ" || access === "WRITE" ? WC_GRANT_SCOPED_PERMISSIONS[access] : [];
}

function assignmentPermissions(assignment: PermissionSnapshot["assignments"][number]): Set<Permission> {
  // Defense in depth for malformed/old rows: WC roles cannot grant non-production
  // permissions; a WC without a site must never turn into a workspace grant.
  if (assignment.workcenterId != null && assignment.siteId === null) return new Set();
  return expandPermissions(
    assignment.permissions.filter(
      (p) =>
        (assignment.workcenterId == null || p.startsWith("production:")) &&
        (p !== OWNER_PERMISSION || (assignment.siteId === null && assignment.workcenterId == null)),
    ),
  );
}

/** Additive workspace + site + exact-workcenter grants; no hierarchy inheritance. */
export function snapshotEffectivePermissions(
  snapshot: PermissionSnapshot,
  siteId?: string,
  workcenterId?: string,
): Set<Permission> {
  if (snapshot.systemRole) return new Set(systemRolePermissions(snapshot.systemRole) ?? []);
  const out = new Set<Permission>();
  for (const assignment of snapshot.assignments) {
    if (assignment.siteId !== null && assignment.siteId !== siteId) continue;
    if (assignment.workcenterId != null && assignment.workcenterId !== workcenterId) continue;
    for (const p of assignmentPermissions(assignment)) out.add(p);
  }
  for (const grant of snapshot.workcenterGrants ?? []) {
    if (!siteId || !workcenterId || grant.siteId !== siteId || grant.workcenterId !== workcenterId) continue;
    for (const p of grantPermissions(grant.access)) out.add(p);
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

/** Sites containing at least one grant; this does NOT prove site-wide access. */
export function snapshotAccessibleSites(snapshot: PermissionSnapshot, permission: Permission): AccessibleSites {
  if (snapshot.systemRole) {
    return systemRolePermissions(snapshot.systemRole)?.has(permission) ? { all: true } : { all: false, siteIds: [] };
  }
  const siteIds = new Set<string>();
  for (const assignment of snapshot.assignments) {
    if (!assignmentPermissions(assignment).has(permission)) continue;
    if (assignment.siteId === null) return { all: true };
    siteIds.add(assignment.siteId);
  }
  for (const grant of snapshot.workcenterGrants ?? []) {
    if (grantPermissions(grant.access).includes(permission)) siteIds.add(grant.siteId);
  }
  return { all: false, siteIds: [...siteIds] };
}

/** Site entry is membership visibility, independent of operational permissions. */
export function snapshotVisibleSites(snapshot: PermissionSnapshot): AccessibleSites {
  if (snapshot.systemRole)
    return systemRolePermissions(snapshot.systemRole) ? { all: true } : { all: false, siteIds: [] };
  const siteIds = new Set<string>();
  for (const assignment of snapshot.assignments) {
    if (assignment.siteId === null) {
      if (assignment.workcenterId == null) return { all: true };
    } else {
      siteIds.add(assignment.siteId);
    }
  }
  for (const grant of snapshot.workcenterGrants ?? []) {
    if (grantPermissions(grant.access).length) siteIds.add(grant.siteId);
  }
  return { all: false, siteIds: [...siteIds] };
}

/** Explicit WC grants/custom assignments only. Use snapshotAccessibleWorkcenters for the all-sites case. */
export function snapshotWorkcentersWithPermission(
  snapshot: PermissionSnapshot,
  permission: Permission,
  siteId: string,
): string[] {
  if (snapshot.systemRole) return [];
  const out = new Set<string>();
  for (const assignment of snapshot.assignments) {
    if (
      assignment.siteId === siteId &&
      assignment.workcenterId != null &&
      assignmentPermissions(assignment).has(permission)
    ) {
      out.add(assignment.workcenterId);
    }
  }
  for (const grant of snapshot.workcenterGrants ?? []) {
    if (grant.siteId === siteId && grantPermissions(grant.access).includes(permission)) out.add(grant.workcenterId);
  }
  return [...out];
}

export function snapshotAccessibleWorkcenters(
  snapshot: PermissionSnapshot,
  permission: Permission,
  siteId: string,
): AccessibleWorkcenters {
  return snapshotHasPermission(snapshot, permission, siteId)
    ? { all: true }
    : { all: false, workcenterIds: snapshotWorkcentersWithPermission(snapshot, permission, siteId) };
}

export function snapshotVisibleWorkcenters(snapshot: PermissionSnapshot, siteId: string): AccessibleWorkcenters {
  return snapshotAccessibleWorkcenters(snapshot, "production:read", siteId);
}

/** Shared catalog/stock/directory access only; never use for live production rows. */
export function snapshotCanReadReferences(snapshot: PermissionSnapshot, siteId: string): boolean {
  const production = snapshotAccessibleWorkcenters(snapshot, "production:read", siteId);
  return (
    snapshotHasPermission(snapshot, "planning:read", siteId) || production.all || production.workcenterIds.length > 0
  );
}

export async function getEffectivePermissions(userId: string, ctx: PermissionContext): Promise<Set<Permission>> {
  const snapshot = await loadPermissionSnapshot(userId, ctx.workspaceId);
  return snapshot ? snapshotEffectivePermissions(snapshot, ctx.siteId, ctx.workcenterId) : new Set();
}
export async function hasPermission(userId: string, permission: Permission, ctx: PermissionContext): Promise<boolean> {
  return (await getEffectivePermissions(userId, ctx)).has(permission);
}
export async function hasAnyPermission(
  userId: string,
  permissions: readonly Permission[],
  ctx: PermissionContext,
): Promise<boolean> {
  const effective = await getEffectivePermissions(userId, ctx);
  return permissions.some((p) => effective.has(p));
}
export async function getAccessibleSites(
  userId: string,
  permission: Permission,
  workspaceId: string,
): Promise<AccessibleSites> {
  const snapshot = await loadPermissionSnapshot(userId, workspaceId);
  return snapshot ? snapshotAccessibleSites(snapshot, permission) : { all: false, siteIds: [] };
}
export async function getVisibleSites(userId: string, workspaceId: string): Promise<AccessibleSites> {
  const snapshot = await loadPermissionSnapshot(userId, workspaceId);
  return snapshot ? snapshotVisibleSites(snapshot) : { all: false, siteIds: [] };
}
export async function listAccessibleSites(
  userId: string,
  workspaceId: string,
  permission?: Permission,
): Promise<AccessibleSiteRef[]> {
  const access = permission
    ? await getAccessibleSites(userId, permission, workspaceId)
    : await getVisibleSites(userId, workspaceId);
  return prisma.site.findMany({
    where: { workspaceId, ...(access.all ? {} : { id: { in: access.siteIds } }) },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

// Migration-only vocabulary. Never consumed by the runtime evaluator.
const LEGACY_RESOURCES = [
  "facility",
  "schedule",
  "job",
  "status",
  "calls",
  "modes",
  "notifications",
  "tool",
  "product",
  "dashboard",
  "entity",
  "graph",
  "user",
  "employee",
  "billing",
  "settings",
] as const;
export const LEGACY_CUSTOM_PERMISSION_CATALOG = LEGACY_RESOURCES.flatMap((r) => ACTIONS.map((a) => `${r}:${a}`));

export interface LegacyPermissionMigrationRule {
  permission: (typeof CUSTOMER_PERMISSIONS)[number];
  /** ALL entries must be explicitly present in ONE role; legacy admin/write did not imply read. */
  requiredPermissions: readonly string[];
  /** The role and its assignments keep their original scope. */
  allowedScopes: readonly PermissionRoleScope[];
  explanation: string;
}

const legacyBundle = (resources: readonly (typeof LEGACY_RESOURCES)[number][], actions: readonly Action[]) =>
  resources.flatMap((resource) => actions.map((action) => `${resource}:${action}`));

const PRODUCTION_LEGACY_READS = legacyBundle(
  [
    "facility",
    "job",
    "status",
    "calls",
    "modes",
    "tool",
    "product",
    "schedule",
    "dashboard",
    "employee",
    "graph",
    "entity",
  ],
  ["read"],
);
const CONFIGURATION_LEGACY_RESOURCES = [
  "facility",
  "job",
  "status",
  "calls",
  "modes",
  "notifications",
  "dashboard",
  "entity",
  "graph",
  "settings",
] as const;
const SITE_ROLE_SCOPES: readonly PermissionRoleScope[] = ["WORKSPACE", "SITE"];
const PRODUCTION_ROLE_SCOPES: readonly PermissionRoleScope[] = [...SITE_ROLE_SCOPES, "WORKCENTER"];

/**
 * Audited responsibility bundles, also embedded verbatim as data in the SQL
 * migration (checked by permissions.migration.test.ts). This is migration/CLI
 * metadata, NEVER a runtime alias catalog. No union across different roles.
 *
 * Production reads include live data plus shared references, recap/schedule
 * reads, dashboards and published graph/entity data. Production writes also
 * cover linked documents (including old facility:admin deletion), product
 * deletion (product:admin), operational writes and comments/signoffs.
 * Configuration includes disposition definitions (job), integrations and
 * automations (settings), and every catalog/configuration mutation group.
 */
export const LEGACY_PERMISSION_MIGRATION_RULES: readonly LegacyPermissionMigrationRule[] = [
  {
    permission: "production:read",
    requiredPermissions: PRODUCTION_LEGACY_READS,
    allowedScopes: PRODUCTION_ROLE_SCOPES,
    explanation: "Complete live-production, reference, recap, directory and published graph/entity read entrances.",
  },
  {
    permission: "production:write",
    requiredPermissions: [
      ...PRODUCTION_LEGACY_READS,
      "facility:write",
      "facility:admin",
      "job:write",
      "status:write",
      "calls:write",
      "modes:write",
      "tool:write",
      "product:write",
      "product:admin",
      "schedule:write",
    ],
    allowedScopes: PRODUCTION_ROLE_SCOPES,
    explanation: "Production reads plus all operational writes, including former product/document admin delete gates.",
  },
  {
    permission: "production:admin",
    requiredPermissions: LEGACY_CUSTOM_PERMISSION_CATALOG,
    allowedScopes: PRODUCTION_ROLE_SCOPES,
    explanation:
      "Deleting others' comments is new authority: only the entire legacy catalog or an explicit current key qualifies.",
  },
  {
    permission: "planning:read",
    requiredPermissions: legacyBundle(["job", "schedule"], ["read"]),
    allowedScopes: SITE_ROLE_SCOPES,
    explanation: "Both fulfillment/job-planning and schedule reads must be present in the same role.",
  },
  {
    permission: "planning:write",
    requiredPermissions: legacyBundle(["job", "schedule"], ACTIONS),
    allowedScopes: SITE_ROLE_SCOPES,
    explanation: "Complete job and schedule read/write/admin bundles: legacy delete/unpublish gates now require write.",
  },
  {
    permission: "configuration:read",
    requiredPermissions: legacyBundle(CONFIGURATION_LEGACY_RESOURCES, ["read"]),
    allowedScopes: SITE_ROLE_SCOPES,
    explanation:
      "Complete configuration/catalog reads, including disposition definitions, integrations and automations.",
  },
  {
    permission: "configuration:write",
    requiredPermissions: legacyBundle(CONFIGURATION_LEGACY_RESOURCES, ACTIONS),
    allowedScopes: SITE_ROLE_SCOPES,
    explanation:
      "Complete configuration read/write/admin bundles, including every former configuration delete/admin gate.",
  },
  {
    permission: "plant:admin",
    requiredPermissions: legacyBundle(["user", "employee", "settings"], ACTIONS),
    allowedScopes: SITE_ROLE_SCOPES,
    explanation:
      "Complete user, employee and settings administration at the existing site/workspace scope; never ownership.",
  },
];

export interface LegacyPermissionMigrationRequirement extends LegacyPermissionMigrationRule {
  missingPermissions: string[];
  scopeAllowed: boolean;
  /** True only for a complete legacy bundle at an allowed scope. */
  legacySatisfied: boolean;
  retained: boolean;
  granted: boolean;
}

/** Pure per-capability evidence for a read-only migration preview, without modifying its input. */
export function getLegacyPermissionMigrationRequirements(
  input: readonly string[],
  scope: PermissionRoleScope = "SITE",
): LegacyPermissionMigrationRequirement[] {
  const held = new Set(input);
  return LEGACY_PERMISSION_MIGRATION_RULES.map((rule) => {
    const missingPermissions = rule.requiredPermissions.filter((p) => !held.has(p));
    const scopeAllowed = rule.allowedScopes.includes(scope);
    const legacySatisfied = scopeAllowed && missingPermissions.length === 0;
    const retained = scopeAllowed && held.has(rule.permission);
    return {
      ...rule,
      requiredPermissions: [...rule.requiredPermissions],
      allowedScopes: [...rule.allowedScopes],
      missingPermissions,
      scopeAllowed,
      legacySatisfied,
      retained,
      granted: retained || legacySatisfied,
    };
  });
}

export interface PermissionMigrationDelta {
  /** Exact original array, including ordering and duplicate strings. */
  originalPermissions: string[];
  permissions: Permission[];
  effectivePermissions: Permission[];
  retainedPermissions: Permission[];
  addedPermissions: Permission[];
  /** Original strings removed from storage, including successfully translated legacy names. */
  droppedPermissions: string[];
  /** Removed strings that did not contribute to any complete, scope-allowed legacy bundle. */
  unmappedPermissions: string[];
  requirements: LegacyPermissionMigrationRequirement[];
  rulesApplied: string[];
  /** Removed legacy names still merit review: an old resource can span multiple new responsibilities. */
  requiresReview: boolean;
}

/**
 * Conservative, pure preview of the SQL custom-role migration. Map complete
 * per-domain bundles within ONE role, including implied reads and old admin
 * gates now requiring write. Never pool grants or use the runtime implication
 * function to satisfy legacy prerequisites. Incomplete domains are dropped;
 * the per-rule missing sets and unmapped strings explain reviewable losses.
 *
 * Current keys are retained; owner:all is never assigned to custom roles; WC
 * roles remain production-only. A fulfilled bundle does not prove ALL uses of
 * its old prerequisites survived (e.g. job:write also gated production writes).
 * Thus any removed string requires review, even if it contributed to a mapped
 * bundle. Original arrays are backed up unchanged in Role.legacyPermissions.
 */
export function mapLegacyCustomPermissions(
  input: readonly string[],
  scope: PermissionRoleScope = "SITE",
): PermissionMigrationDelta {
  const requirements = getLegacyPermissionMigrationRequirements(input, scope);
  const applied = requirements.filter((rule) => rule.legacySatisfied);
  const permissions = requirements.filter((rule) => rule.granted).map((rule) => rule.permission);
  const retained = new Set<string>(permissions);
  const droppedPermissions = [...new Set(input.filter((p) => !retained.has(p)))];
  const translated = new Set(applied.flatMap((rule) => rule.requiredPermissions));
  return {
    originalPermissions: [...input],
    permissions,
    effectivePermissions: [...expandPermissions(permissions)],
    retainedPermissions: permissions.filter((p) => input.includes(p)),
    addedPermissions: permissions.filter((p) => !input.includes(p)),
    droppedPermissions,
    unmappedPermissions: droppedPermissions.filter((p) => !translated.has(p)),
    requirements,
    rulesApplied: applied.map((rule) => rule.permission),
    requiresReview: droppedPermissions.length > 0,
  };
}

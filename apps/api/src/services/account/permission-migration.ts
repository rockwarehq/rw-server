import {
  expandPermissions,
  mapLegacyCustomPermissions,
  WC_GRANT_SCOPED_PERMISSIONS,
  type PermissionRoleScope,
} from "@rw/auth/iam/permissions";
import { SYSTEM_ROLE_SPECS } from "../../seed-system-roles.js";

export interface MigrationRoleRow {
  id: string;
  workspaceId: string;
  name: string;
  scope: PermissionRoleScope;
  isSystem: boolean;
  permissions: string[];
  legacyPermissions?: unknown;
  hasLegacyPermissionsColumn?: boolean;
}

export interface MigrationAssignmentRow {
  id: string;
  roleId: string;
  membershipId: string;
  siteId: string | null;
  workcenterId?: string | null;
}

export interface MigrationWorkcenterGrantRow {
  id: string;
  workspaceId: string;
  membershipId: string;
  siteId: string;
  workcenterId: string;
  access: string;
}

/** Credential values must never enter the preview dataset; the reader selects only this boolean. */
export interface MigrationDisplayRow {
  id: string;
  workspaceId: string | null;
  siteId: string | null;
  stationId: string | null;
  workcenterId: string | null;
  status: string;
  hasBootstrapSecret: boolean;
}

export interface PermissionMigrationDataset {
  workspaces: Array<{ id: string; name: string }>;
  roles: MigrationRoleRow[];
  assignments: MigrationAssignmentRow[];
  workcenterGrants: MigrationWorkcenterGrantRow[];
  displays: MigrationDisplayRow[];
}

const LEGACY_WORKCENTER_GLOBAL_READS = [
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
const LEGACY_WORKCENTER_GLOBAL_WRITES = [
  "job:write",
  "schedule:write",
  "tool:write",
  "product:write",
  "entity:write",
  "graph:write",
  "dashboard:write",
];
const sameArray = (a: readonly string[], b: readonly string[]) => JSON.stringify(a) === JSON.stringify(b);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((p) => typeof p === "string");

/** Pure historical preview. Backups reconstruct the migration; current values are shown separately, never reapplied. */
export function previewPermissionRole(role: MigrationRoleRow, assignments: readonly MigrationAssignmentRow[]) {
  const usesBackup = strings(role.legacyPermissions);
  const original = usesBackup ? (role.legacyPermissions as string[]) : role.permissions;
  const spec = SYSTEM_ROLE_SPECS.find((s) => s.name === role.name && s.scope === role.scope);
  const collision = !role.isSystem && spec !== undefined;
  const custom = role.isSystem ? null : mapLegacyCustomPermissions(original, role.scope);
  // Unknown system rows are not targeted by the SQL's explicit built-in upsert.
  const proposedPermissions = custom ? [...custom.permissions] : [...(spec?.permissions ?? role.permissions)];
  const affectedAssignments = assignments
    .filter((a) => a.roleId === role.id)
    .map((a) => {
      const workcenterId = a.workcenterId ?? null;
      const scope = workcenterId ? "WORKCENTER" : a.siteId ? "SITE" : "WORKSPACE";
      return {
        id: a.id,
        membershipId: a.membershipId,
        siteId: a.siteId,
        workcenterId,
        scope,
        scopeMismatch: scope !== role.scope || (workcenterId !== null && a.siteId === null),
        scopeChange: "None: membership, role ID, site and workcenter bindings are preserved.",
      };
    });
  const backupIssue =
    role.legacyPermissions != null && !usesBackup
      ? "Invalid legacyPermissions backup; preview uses current permissions and needs manual review."
      : null;
  return {
    id: role.id,
    workspaceId: role.workspaceId,
    name: role.name,
    scope: role.scope,
    isSystem: role.isSystem,
    classification: role.isSystem ? (spec ? "BUILT_IN" : "UNKNOWN_SYSTEM_ROLE") : "CUSTOM",
    source: usesBackup ? "MIGRATION_BACKUP" : "CURRENT_PERMISSIONS",
    schemaState: role.hasLegacyPermissionsColumn || usesBackup ? "MIGRATED" : "PRE_UPGRADE",
    originalPermissions: [...original],
    storedPermissions: [...role.permissions],
    proposedPermissions,
    effectivePermissions: [...expandPermissions(proposedPermissions)],
    changedFromOriginal: !sameArray(original, proposedPermissions),
    differsFromStored: !sameArray(role.permissions, proposedPermissions),
    nameCollision: collision,
    backupIssue,
    requiresReview: Boolean(
      collision ||
        backupIssue ||
        custom?.requiresReview ||
        (role.isSystem && !spec) ||
        (usesBackup && !sameArray(role.permissions, proposedPermissions)) ||
        affectedAssignments.some((a) => a.scopeMismatch),
    ),
    customMapping: custom,
    assignments: affectedAssignments,
  };
}

export function previewWorkcenterGrant(grant: MigrationWorkcenterGrantRow) {
  const valid = grant.access === "READ" || grant.access === "WRITE";
  return {
    id: grant.id,
    workspaceId: grant.workspaceId,
    membershipId: grant.membershipId,
    siteId: grant.siteId,
    workcenterId: grant.workcenterId,
    access: grant.access,
    proposedAccess: grant.access,
    scopedPermissions: valid ? [...WC_GRANT_SCOPED_PERMISSIONS[grant.access as "READ" | "WRITE"]] : [],
    removedSiteGlobalReads: valid ? [...LEGACY_WORKCENTER_GLOBAL_READS] : [],
    removedSiteGlobalWrites: grant.access === "WRITE" ? [...LEGACY_WORKCENTER_GLOBAL_WRITES] : [],
    promotedToEngineer: false,
    requiresReview: true,
    explanation: valid
      ? "The grant row is preserved. Only production access at this workcenter remains; shared-reference reads require the explicit reference policy. Site-global writes are not retained. Other roles may independently preserve access."
      : "Unknown workcenter access level grants no permissions; review this row.",
  };
}

/** Pure report builder. Project fields explicitly so even accidentally supplied credential properties cannot leak. */
export function buildPermissionMigrationPreview(dataset: PermissionMigrationDataset, workspaceId?: string) {
  const workspaces = dataset.workspaces
    .filter((w) => !workspaceId || w.id === workspaceId)
    .map((w) => ({ id: w.id, name: w.name }));
  const roles = dataset.roles
    .filter((r) => !workspaceId || r.workspaceId === workspaceId)
    .map((r) => previewPermissionRole(r, dataset.assignments));
  const workcenterGrants = dataset.workcenterGrants
    .filter((g) => !workspaceId || g.workspaceId === workspaceId)
    .map(previewWorkcenterGrant);
  const claimed = dataset.displays.filter(
    (d) => d.status === "CLAIMED" && (!workspaceId || d.workspaceId === workspaceId),
  );
  const group = (predicate: (d: MigrationDisplayRow) => boolean) => {
    const ids = claimed.filter(predicate).map((d) => d.id);
    return { count: ids.length, ids };
  };
  const roleNameCollisions = roles
    .filter((r) => r.nameCollision)
    .map((r) => ({
      roleId: r.id,
      workspaceId: r.workspaceId,
      name: r.name,
      scope: r.scope,
      explanation:
        "The custom role remains custom. Its permissions use the custom mapper; the built-in with this name is not created or substituted.",
    }));
  const builtInsToCreate = workspaces.flatMap((workspace) =>
    SYSTEM_ROLE_SPECS.filter(
      (spec) => !roles.some((r) => r.workspaceId === workspace.id && r.name === spec.name && r.scope === spec.scope),
    ).map((spec) => ({
      workspaceId: workspace.id,
      name: spec.name,
      scope: spec.scope,
      permissions: [...spec.permissions],
    })),
  );
  return {
    mode: "READ_ONLY_PREVIEW" as const,
    workspaceFilter: workspaceId ?? null,
    workspaces,
    summary: {
      workspaces: workspaces.length,
      roles: roles.length,
      rolesRequiringReview: roles.filter((r) => r.requiresReview).length,
      rolesChangedFromOriginal: roles.filter((r) => r.changedFromOriginal).length,
      assignments: roles.reduce((total, r) => total + r.assignments.length, 0),
      affectedAssignments: roles
        .filter((r) => r.changedFromOriginal || r.requiresReview)
        .reduce((total, r) => total + r.assignments.length, 0),
      builtInsToCreate: builtInsToCreate.length,
      roleNameCollisions: roleNameCollisions.length,
      workcenterGrants: workcenterGrants.length,
      workcenterWriteGrantsLosingGlobalWrites: workcenterGrants.filter((g) => g.access === "WRITE").length,
      claimedDisplays: claimed.length,
      claimedDisplaysMissingBootstrap: claimed.filter((d) => !d.hasBootstrapSecret).length,
    },
    roles,
    builtInsToCreate,
    roleNameCollisions,
    workcenterGrants,
    displays: {
      stationBound: group((d) => d.siteId !== null && d.stationId !== null),
      siteBound: group((d) => d.siteId !== null && d.stationId === null),
      missingSite: group((d) => d.siteId === null),
      missingBootstrap: group((d) => !d.hasBootstrapSecret),
      bindings: claimed.map((d) => ({
        id: d.id,
        workspaceId: d.workspaceId,
        siteId: d.siteId,
        stationId: d.stationId,
        workcenterId: d.workcenterId,
        mode: !d.siteId ? "MISSING_SITE" : d.stationId ? "STATION_BOUND" : "SITE_BOUND",
      })),
    },
    scopeNotes: [
      "Role/assignment IDs and membership/site/workcenter bindings are preserved; complete custom bundles are evaluated within one role only.",
      "Migrated roles use legacyPermissions to reconstruct the migration. Differences from stored permissions may reflect subsequent edits; this report never reapplies them.",
      "Plant Member retains planning reads without site-wide production reads. Production scope comes from assigned workcenters or explicit site/workspace production roles.",
      "Workcenter READ/WRITE remains scoped production READ/WRITE, never Engineer. Legacy site-global grants and base-workcenter-access marker behavior are removed.",
      "Legacy removed names can span several new responsibilities. Inspect customMapping.requirements and unmappedPermissions, not just whether a bundle contributed to a new permission.",
      "Claimed display station/site binding and existing bootstrap/refresh credentials are preserved. A workcenter binding alone does not make a display station-fixed; station deletion now restricts instead of silently unbinding it.",
      "Legacy user comments retain USER identity, unattributed comments become UNKNOWN, and existing comments gain no invented operator verification evidence.",
    ],
  };
}

export type PermissionMigrationPreview = ReturnType<typeof buildPermissionMigrationPreview>;

export function formatPermissionMigrationPreview(report: PermissionMigrationPreview): string {
  const lines = [
    "Permission migration preview (read only)",
    `Workspaces: ${report.summary.workspaces}; roles: ${report.summary.roles}; review: ${report.summary.rolesRequiringReview}`,
    `Affected assignments: ${report.summary.affectedAssignments}/${report.summary.assignments}; built-ins to create: ${report.summary.builtInsToCreate}`,
    `Custom-name collisions: ${report.summary.roleNameCollisions}; WC WRITE grants losing global writes: ${report.summary.workcenterWriteGrantsLosingGlobalWrites}`,
    `Claimed displays: ${report.summary.claimedDisplays}; station-bound: ${report.displays.stationBound.count}; site-bound: ${report.displays.siteBound.count}; missing site: ${report.displays.missingSite.count}`,
    `Station-bound display IDs: [${report.displays.stationBound.ids.join(", ")}]`,
    `Site-bound display IDs: [${report.displays.siteBound.ids.join(", ")}]`,
    `Missing display bootstrap: ${report.displays.missingBootstrap.count} [${report.displays.missingBootstrap.ids.join(", ")}]`,
    "",
  ];
  for (const role of report.roles) {
    lines.push(`${role.id} ${JSON.stringify(role.name)} (${role.scope}, ${role.classification}, ${role.source})`);
    lines.push(`  Original: ${JSON.stringify(role.originalPermissions)}`);
    lines.push(`  Proposed: ${JSON.stringify(role.proposedPermissions)}`);
    if (role.source === "MIGRATION_BACKUP") lines.push(`  Stored: ${JSON.stringify(role.storedPermissions)}`);
    if (role.nameCollision) lines.push("  COLLISION: custom role retained; built-in name is blocked.");
    if (role.backupIssue) lines.push(`  ${role.backupIssue}`);
    for (const assignment of role.assignments) {
      lines.push(
        `  Assignment ${assignment.id}: membership=${assignment.membershipId} site=${assignment.siteId ?? "*"} workcenter=${assignment.workcenterId ?? "*"}${assignment.scopeMismatch ? " [SCOPE MISMATCH]" : ""}`,
      );
    }
    for (const requirement of role.customMapping?.requirements ?? []) {
      if (!requirement.granted) {
        lines.push(
          `  ${requirement.permission}: ${requirement.scopeAllowed ? `missing ${JSON.stringify(requirement.missingPermissions)}` : "not allowed at this scope"}`,
        );
      }
    }
  }
  for (const grant of report.workcenterGrants) {
    lines.push(
      `WC grant ${grant.id}: ${grant.access} at ${grant.workcenterId}; scoped=${JSON.stringify(grant.scopedPermissions)}; removed global writes=${JSON.stringify(grant.removedSiteGlobalWrites)}`,
    );
  }
  for (const builtin of report.builtInsToCreate)
    lines.push(`Missing built-in: ${JSON.stringify(builtin.name)} in ${builtin.workspaceId}`);
  lines.push("", ...report.scopeNotes);
  return lines.join("\n");
}

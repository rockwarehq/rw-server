import prisma from "@rw/db";
import type { RoleScope } from "@rw/db";
import { ACTIONS, ALL_PERMISSIONS, type RESOURCES, type Permission } from "@rw/auth/iam/permissions";

const all = (resource: (typeof RESOURCES)[number]): Permission[] =>
  ACTIONS.map((action) => `${resource}:${action}` as Permission);

const COMPANY_ADMINISTRATOR_PERMISSIONS: readonly Permission[] = [...ALL_PERMISSIONS];

const PLANT_ADMIN_PERMISSIONS: readonly Permission[] = [
  ...all("facility"),
  ...all("schedule"),
  ...all("job"),
  ...all("status"),
  ...all("calls"),
  ...all("modes"),
  ...all("notifications"),
  ...all("tool"),
  ...all("product"),
  ...all("dashboard"),
  ...all("entity"),
  ...all("graph"),
  ...all("employee"),
  "user:read",
  "user:write",
  // user:admin at SITE scope unlocks site-scoped member removal
  // (DELETE /workspaces/:id/members/:userId/site-access). Workspace-level
  // user administration (org-wide removal, admin password resets, disable)
  // stays behind scope:"workspace" checks that a site grant cannot satisfy.
  "user:admin",
  "settings:read",
  "settings:write",
  // Plant Admin is the site-level superuser ("admin gets everything"):
  // settings:admin and billing round out the full set. Only owner:all stays
  // off — the workspace-ownership marker belongs to Company Administrator.
  // Site-scoped assignment still bounds the blast radius: workspace-level
  // actions sit behind scope:"workspace" checks a SITE assignment cannot
  // satisfy.
  "settings:admin",
  ...all("billing"),
];

const PLANT_MEMBER_PERMISSIONS: readonly Permission[] = [
  "facility:read",
  "product:read",
  "job:read",
  "status:read",
  "calls:read",
  "modes:read",
  "notifications:read",
  "tool:read",
  "schedule:read",
  "dashboard:read",
  "entity:read",
  "graph:read",
  "employee:read",
];

interface SystemRoleSpec {
  name: string;
  description: string;
  scope: RoleScope;
  permissions: readonly Permission[];
}

export const SYSTEM_ROLE_SPECS: readonly SystemRoleSpec[] = [
  {
    name: "Company Administrator",
    description: "Company-level administrator with billing visibility and full operational access across all sites.",
    scope: "WORKSPACE",
    permissions: COMPANY_ADMINISTRATOR_PERMISSIONS,
  },
  {
    name: "Plant Admin",
    description: "Plant administrator with full access to all plant data, settings, and user management.",
    scope: "SITE",
    permissions: PLANT_ADMIN_PERMISSIONS,
  },
  {
    // The base membership tier (GitHub's "Member"): read access site-wide,
    // with floor visibility (status/calls) subject to the site's
    // baseWorkcenterAccess policy — under GRANTS_REQUIRED those come only
    // from workcenter grants. The policy lives in the evaluator, not here.
    name: "Plant Member",
    description:
      "Base plant membership with read access to plant data. Workcenter access can be granted per workcenter.",
    scope: "SITE",
    permissions: PLANT_MEMBER_PERMISSIONS,
  },
];

export async function seedSystemRoles(workspaceId: string): Promise<void> {
  for (const spec of SYSTEM_ROLE_SPECS) {
    await prisma.role.upsert({
      where: { workspaceId_name_scope: { workspaceId, name: spec.name, scope: spec.scope } },
      create: {
        workspaceId,
        name: spec.name,
        description: spec.description,
        scope: spec.scope,
        permissions: [...spec.permissions],
        isSystem: true,
      },
      update: {
        description: spec.description,
        permissions: [...spec.permissions],
        isSystem: true,
      },
    });
  }
}

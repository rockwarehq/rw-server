import prisma from "@rw/db";
import type { RoleScope } from "@rw/db";
import {
  ACTIONS,
  ALL_PERMISSIONS,
  CUSTOMER_PERMISSIONS,
  type RESOURCES,
  type Permission,
} from "@rw/auth/iam/permissions";

const all = (resource: (typeof RESOURCES)[number]): Permission[] =>
  ACTIONS.map((action) => `${resource}:${action}` as Permission);

// TRANSITION NOTE: built-in bundles carry BOTH permission vocabularies while
// call sites migrate from the 49 legacy keys to the eight new ones. The
// legacy halves below are deleted (and the bundles become new-key-only) by
// the contract step. Planner and Plant Engineer are new roles with no legacy
// history, so they are new-key-only from birth.

// ALL_PERMISSIONS already spans both vocabularies plus owner:all.
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
  // New vocabulary: the full eight-key set (still never owner:all).
  ...CUSTOMER_PERMISSIONS,
];

// Target model: Plant Member is planning visibility only — production
// visibility comes from workcenter grants, not from the base membership
// tier. The legacy reads keep today's behavior alive until the old checks
// are gone; deliberately NO production:read here.
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
  "planning:read",
];

const PLANNER_PERMISSIONS: readonly Permission[] = ["planning:write"];

const PLANT_ENGINEER_PERMISSIONS: readonly Permission[] = ["production:admin", "planning:write", "configuration:write"];

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
  {
    name: "Planner",
    description: "Manages orders, customers and scheduling. Production visibility follows workcenter access.",
    scope: "SITE",
    permissions: PLANNER_PERMISSIONS,
  },
  {
    name: "Plant Engineer",
    description: "Full production, planning and technical setup authority for the plant.",
    scope: "SITE",
    permissions: PLANT_ENGINEER_PERMISSIONS,
  },
];

/**
 * Idempotent, and it never adopts a customer's role: create-if-absent skips
 * a same-named customer role (unique on workspace+name+scope), and the
 * refresh only touches rows already marked isSystem. A customer role named
 * like a built-in must be renamed before that built-in can appear.
 */
export async function seedSystemRoles(workspaceId: string): Promise<void> {
  for (const spec of SYSTEM_ROLE_SPECS) {
    await prisma.role.createMany({
      data: [
        {
          workspaceId,
          name: spec.name,
          description: spec.description,
          scope: spec.scope,
          permissions: [...spec.permissions],
          isSystem: true,
        },
      ],
      skipDuplicates: true,
    });
    await prisma.role.updateMany({
      where: { workspaceId, name: spec.name, scope: spec.scope, isSystem: true },
      data: { description: spec.description, permissions: [...spec.permissions] },
    });
  }
}

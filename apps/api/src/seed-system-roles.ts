import prisma from "@rw/db";
import type { RoleScope } from "@rw/db";
import { ALL_PERMISSIONS, type Permission } from "@rw/auth/iam/permissions";

// Built-in role presets over the eight-key catalog. Write implies read and
// production:admin implies write (the evaluator closes over implications),
// so bundles list only their top tiers.

// Every capability plus reserved company ownership.
const COMPANY_ADMINISTRATOR_PERMISSIONS: readonly Permission[] = [...ALL_PERMISSIONS];

const PLANT_ENGINEER_PERMISSIONS: readonly Permission[] = ["production:admin", "planning:write", "configuration:write"];

// Engineer authority plus people/access administration. Site-scoped
// assignment still bounds the blast radius: workspace-level actions sit
// behind scope:"workspace" checks a SITE assignment cannot satisfy.
const PLANT_ADMIN_PERMISSIONS: readonly Permission[] = [...PLANT_ENGINEER_PERMISSIONS, "plant:admin"];

// The base membership tier: planning visibility only. Production visibility
// comes from workcenter grants, never from base membership.
const PLANT_MEMBER_PERMISSIONS: readonly Permission[] = ["planning:read"];

const PLANNER_PERMISSIONS: readonly Permission[] = ["planning:write"];

interface SystemRoleSpec {
  name: string;
  description: string;
  scope: RoleScope;
  permissions: readonly Permission[];
}

export const SYSTEM_ROLE_SPECS: readonly SystemRoleSpec[] = [
  {
    name: "Company Administrator",
    description: "Company-level administrator with full operational access and reserved ownership across all sites.",
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
    name: "Plant Member",
    description: "Base plant membership with planning visibility. Production access can be granted per workcenter.",
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

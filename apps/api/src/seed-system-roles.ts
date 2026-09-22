import prisma from "@rw/db";
import type { RoleScope } from "@rw/db";
import { ALL_PERMISSIONS, type Permission } from "@rw/auth/iam/permissions";

const COMPANY_ADMINISTRATOR_PERMISSIONS: readonly Permission[] = [...ALL_PERMISSIONS];

const PLANT_ENGINEER_PERMISSIONS: readonly Permission[] = ["production:admin", "planning:write", "configuration:write"];
const PLANT_ADMIN_PERMISSIONS: readonly Permission[] = [...PLANT_ENGINEER_PERMISSIONS, "plant:admin"];
const PLANT_MEMBER_PERMISSIONS: readonly Permission[] = ["planning:read"];

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
    name: "Plant Member",
    description: "Plant membership and planning reads. Production access requires assigned workcenters.",
    scope: "SITE",
    permissions: PLANT_MEMBER_PERMISSIONS,
  },
  {
    name: "Planner",
    description: "Planning read/write access without site-wide production access.",
    scope: "SITE",
    permissions: ["planning:write"],
  },
  {
    name: "Plant Engineer",
    description: "Production administration, planning and configuration across the plant.",
    scope: "SITE",
    permissions: PLANT_ENGINEER_PERMISSIONS,
  },
];

export async function seedSystemRoles(workspaceId: string): Promise<void> {
  for (const spec of SYSTEM_ROLE_SPECS) {
    // A customer may already use a new built-in name. Never convert that role
    // (and its assignments) into a broader system role merely by seeding,
    // including when the custom role is created concurrently with this seed.
    await prisma.role.createMany({
      skipDuplicates: true,
      data: {
        workspaceId,
        name: spec.name,
        description: spec.description,
        scope: spec.scope,
        permissions: [...spec.permissions],
        isSystem: true,
      },
    });
    await prisma.role.updateMany({
      where: { workspaceId, name: spec.name, scope: spec.scope, isSystem: true },
      data: {
        description: spec.description,
        permissions: [...spec.permissions],
      },
    });
  }
}

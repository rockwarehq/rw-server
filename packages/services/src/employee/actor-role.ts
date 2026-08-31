import prisma from "@rw/db";

// Shared employee-role gate for definition-scoped shop-floor actions (calls
// today; alarms and similar modules reuse the same convention): allowed-role
// lists live on the definition, an empty list means everyone, and an actor
// passes when their active site role is listed.

/** The acting employee's role at a site, or null (no employee, no access row, or inactive access). */
export async function actorSiteRoleId(employeeId: string | null, siteId: string): Promise<string | null> {
  if (!employeeId) return null;
  const access = await prisma.employeeSiteAccess.findUnique({
    where: { employeeId_siteId: { employeeId, siteId } },
    select: { roleId: true, status: true },
  });
  return access?.status === "ACTIVE" ? access.roleId : null;
}

export function roleAllowed(roleId: string | null, allowedRoleIds: string[]): boolean {
  if (allowedRoleIds.length === 0) return true;
  return roleId !== null && allowedRoleIds.includes(roleId);
}

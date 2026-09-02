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

/** True when the actor's active site role is in the allow-list (empty list = everyone). */
export async function actorRoleAllowed(
  employeeId: string | null,
  siteId: string,
  allowedRoles: Array<{ id: string }>,
): Promise<boolean> {
  if (allowedRoles.length === 0) return true;
  const roleId = await actorSiteRoleId(employeeId, siteId);
  return roleAllowed(
    roleId,
    allowedRoles.map((role) => role.id),
  );
}

/** All ids must be employee roles of the given site. */
export async function validateSiteRoleIds(
  siteId: string,
  roleIds: string[],
): Promise<{ error: string; code: string } | null> {
  if (roleIds.length === 0) return null;
  const count = await prisma.employeeRole.count({ where: { id: { in: roleIds }, siteId } });
  if (count !== new Set(roleIds).size) {
    return { error: "One or more employee roles not found for this site", code: "ROLE_NOT_FOUND" };
  }
  return null;
}

/**
 * Resolve who is acting. An explicit employeeId must exist in the workspace;
 * a userId resolves through their WorkspaceMembership.employee link, which
 * may legitimately be unset (unattributed action, not an error).
 */
export async function resolveEmployee(
  workspaceId: string,
  employeeId?: string,
  userId?: string,
): Promise<{ employeeId: string | null; employeeVersionId: string | null } | { error: string; code: string }> {
  if (employeeId) {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, workspaceId: true, versionId: true },
    });
    if (!employee || employee.workspaceId !== workspaceId) {
      return { error: "Employee not found", code: "EMPLOYEE_NOT_FOUND" };
    }
    return { employeeId, employeeVersionId: employee.versionId };
  }
  if (userId) {
    const membership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { employeeId: true, employee: { select: { versionId: true } } },
    });
    return {
      employeeId: membership?.employeeId ?? null,
      employeeVersionId: membership?.employee?.versionId ?? null,
    };
  }
  return { employeeId: null, employeeVersionId: null };
}

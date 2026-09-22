import prisma, { type Prisma } from "@rw/db";

// Shared employee-role gate for definition-scoped shop-floor actions (calls
// today; alarms and similar modules reuse the same convention): allowed-role
// lists live on the definition, an empty list means everyone, and an actor
// passes when their active site role is listed.

/** The acting employee's role at a site, or null (no employee, no access row, or inactive access). */
export async function actorSiteRoleId(employeeId: string | null, siteId: string): Promise<string | null> {
  if (!employeeId) return null;
  const access = await prisma.employeeSiteAccess.findUnique({
    where: { employeeId_siteId: { employeeId, siteId } },
    select: { roleId: true, status: true, employee: { select: { status: true } }, role: { select: { siteId: true } } },
  });
  return access?.status === "ACTIVE" && access.employee.status === "ACTIVE" && access.role.siteId === siteId
    ? access.roleId
    : null;
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
  // Account identity always wins; an explicit employee cannot impersonate a colleague.
  if (userId) {
    const membership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { employeeId: true, employee: { select: { versionId: true, status: true } } },
    });
    if (employeeId && employeeId !== membership?.employeeId) {
      return { error: "Cannot attribute an account action to another employee", code: "FORBIDDEN" };
    }
    if (membership?.employee && membership.employee.status !== "ACTIVE") {
      if (employeeId) return { error: "Employee is inactive", code: "FORBIDDEN" };
      return { employeeId: null, employeeVersionId: null };
    }
    return { employeeId: membership?.employeeId ?? null, employeeVersionId: membership?.employee?.versionId ?? null };
  }
  if (employeeId) {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, workspaceId: true, versionId: true, status: true },
    });
    if (!employee || employee.workspaceId !== workspaceId || employee.status !== "ACTIVE") {
      return { error: "Employee not found", code: "EMPLOYEE_NOT_FOUND" };
    }
    return { employeeId, employeeVersionId: employee.versionId };
  }
  return { employeeId: null, employeeVersionId: null };
}

export type ActorAssurance = "TERMINAL" | "IDENTIFIED" | "VERIFIED" | "ACCOUNT";
export interface ActionActor {
  employeeId: string | null;
  employeeVersionId: string | null;
  userId?: string;
  displayId?: string;
  operatorSessionId?: string;
  assurance: ActorAssurance;
}

export interface ResolveActionActorInput {
  workspaceId: string;
  siteId: string;
  userId?: string;
  displayId?: string;
  employeeId?: string;
  operatorSessionId?: string;
}

const attributionDenied = (reason: string) => ({
  error: "Employee attribution is not valid for this action",
  code: "FORBIDDEN" as const,
  reason,
});

/** Session station is attendance, not action scope: identity can roam within the display's site. */
export async function resolveActionActor(
  input: ResolveActionActorInput,
): Promise<ActionActor | ReturnType<typeof attributionDenied>> {
  if (input.userId) {
    if (input.operatorSessionId) return attributionDenied("ACCOUNT_SESSION_ATTRIBUTION_NOT_ALLOWED");
    const employee = await resolveEmployee(input.workspaceId, input.employeeId, input.userId);
    if ("error" in employee) return attributionDenied("ACCOUNT_EMPLOYEE_MISMATCH");
    if (employee.employeeId && !(await actorSiteRoleId(employee.employeeId, input.siteId))) {
      if (input.employeeId) return attributionDenied("EMPLOYEE_SITE_ACCESS_INACTIVE");
      // Workforce linkage is optional: an account user's authority at this plant
      // does not depend on their employee profile having access to the same plant.
      return { userId: input.userId, employeeId: null, employeeVersionId: null, assurance: "ACCOUNT" };
    }
    return { ...employee, userId: input.userId, assurance: "ACCOUNT" };
  }
  if (!input.displayId) return attributionDenied("ACTOR_CONTEXT_REQUIRED");
  const terminal: ActionActor = {
    employeeId: null,
    employeeVersionId: null,
    displayId: input.displayId,
    assurance: "TERMINAL",
  };
  if (!input.operatorSessionId && !input.employeeId) return terminal;

  const sessionSelect = {
    id: true,
    employeeId: true,
    displayId: true,
    siteId: true,
    logoffTime: true,
    logonMethod: true,
    station: { select: { siteId: true } },
  } as const;
  let session: Prisma.StationLogonSessionGetPayload<{ select: typeof sessionSelect }> | null | undefined;
  if (input.operatorSessionId) {
    session = await prisma.stationLogonSession.findUnique({
      where: { id: input.operatorSessionId },
      select: sessionSelect,
    });
  } else {
    // Legacy adapter: never choose the first of several sessions, even for the same employee.
    const sessions = await prisma.stationLogonSession.findMany({
      where: {
        displayId: input.displayId,
        employeeId: input.employeeId,
        logoffTime: null,
        station: { siteId: input.siteId },
        OR: [{ siteId: input.siteId }, { siteId: null }],
      },
      select: sessionSelect,
      take: 2,
    });
    if (sessions.length !== 1)
      return attributionDenied(sessions.length ? "OPERATOR_SESSION_AMBIGUOUS" : "OPERATOR_SESSION_REQUIRED");
    session = sessions[0];
  }
  if (
    !session ||
    session.logoffTime ||
    session.displayId !== input.displayId ||
    session.station.siteId !== input.siteId ||
    (session.siteId !== null && session.siteId !== input.siteId)
  ) {
    return attributionDenied("OPERATOR_SESSION_INVALID");
  }
  if (input.employeeId && input.employeeId !== session.employeeId)
    return attributionDenied("OPERATOR_EMPLOYEE_MISMATCH");
  if (session.logonMethod === "GENERIC" && !session.employeeId) return { ...terminal, operatorSessionId: session.id };
  if (!session.employeeId || !["EMPLOYEE_ID", "BADGE", "PIN"].includes(session.logonMethod))
    return attributionDenied("OPERATOR_SESSION_INVALID");
  const employee = await resolveEmployee(input.workspaceId, session.employeeId);
  if ("error" in employee) return attributionDenied("EMPLOYEE_INACTIVE");
  if (!(await actorSiteRoleId(session.employeeId, input.siteId)))
    return attributionDenied("EMPLOYEE_SITE_ACCESS_INACTIVE");
  return {
    ...employee,
    displayId: input.displayId,
    operatorSessionId: session.id,
    assurance: session.logonMethod === "PIN" ? "VERIFIED" : "IDENTIFIED",
  };
}

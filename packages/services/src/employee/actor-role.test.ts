import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({
  employee: { findUnique: vi.fn() },
  employeeSiteAccess: { findUnique: vi.fn() },
  workspaceMembership: { findUnique: vi.fn() },
  stationLogonSession: { findUnique: vi.fn(), findMany: vi.fn() },
}));
vi.mock("@rw/db", () => ({ default: db }));
import { actorRoleAllowed, resolveActionActor } from "./actor-role.js";

const input = { workspaceId: "workspace", siteId: "site", displayId: "display" };
const session = {
  id: "session",
  employeeId: "employee",
  displayId: "display",
  siteId: "site",
  logoffTime: null,
  logonMethod: "PIN",
  stationId: "attendance-station",
  station: { siteId: "site" },
};
beforeEach(() => {
  vi.resetAllMocks();
  db.employee.findUnique.mockResolvedValue({
    id: "employee",
    workspaceId: "workspace",
    versionId: "current-version",
    status: "ACTIVE",
  });
  db.employeeSiteAccess.findUnique.mockResolvedValue({
    status: "ACTIVE",
    roleId: "qualified",
    role: { siteId: "site" },
    employee: { status: "ACTIVE" },
  });
  db.stationLogonSession.findUnique.mockResolvedValue(session);
  db.stationLogonSession.findMany.mockResolvedValue([session]);
  db.workspaceMembership.findUnique.mockResolvedValue({
    employeeId: "employee",
    employee: { versionId: "current-version", status: "ACTIVE" },
  });
});

describe("action employee identification", () => {
  it("basic actions are terminal-only and do not pick a logged-on employee", async () => {
    expect(await resolveActionActor(input)).toEqual({
      employeeId: null,
      employeeVersionId: null,
      displayId: "display",
      assurance: "TERMINAL",
    });
    expect(db.stationLogonSession.findMany).not.toHaveBeenCalled();
  });
  it.each([
    ["EMPLOYEE_ID", "IDENTIFIED"],
    ["BADGE", "IDENTIFIED"],
    ["PIN", "VERIFIED"],
  ])("records %s as %s", async (logonMethod, assurance) => {
    db.stationLogonSession.findUnique.mockResolvedValue({ ...session, logonMethod });
    expect(await resolveActionActor({ ...input, operatorSessionId: "session" })).toMatchObject({
      employeeId: "employee",
      employeeVersionId: "current-version",
      assurance,
    });
  });
  it("does not treat a generic name as a person", async () => {
    db.stationLogonSession.findUnique.mockResolvedValue({ ...session, employeeId: null, logonMethod: "GENERIC" });
    expect(await resolveActionActor({ ...input, operatorSessionId: "session" })).toMatchObject({
      employeeId: null,
      assurance: "TERMINAL",
    });
  });
  it("keeps attendance station separate and supports legacy null site stamps", async () => {
    db.stationLogonSession.findUnique.mockResolvedValue({ ...session, siteId: null });
    expect(await resolveActionActor({ ...input, operatorSessionId: "session" })).toMatchObject({
      employeeId: "employee",
    });
    expect(db.stationLogonSession.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "session" } }),
    );
  });
  it.each([
    { displayId: "other" },
    { siteId: "other" },
    { station: { siteId: "other" } },
    { logoffTime: new Date() },
  ])("rejects an invalid explicit session: %j", async (change) => {
    db.stationLogonSession.findUnique.mockResolvedValue({ ...session, ...change });
    expect(await resolveActionActor({ ...input, operatorSessionId: "session" })).toMatchObject({
      code: "FORBIDDEN",
      reason: "OPERATOR_SESSION_INVALID",
    });
  });
  it("accepts raw employeeId only for one active matching session on this display", async () => {
    expect(await resolveActionActor({ ...input, employeeId: "employee" })).toMatchObject({
      employeeId: "employee",
      operatorSessionId: "session",
    });
    db.stationLogonSession.findMany.mockResolvedValueOnce([]);
    expect(await resolveActionActor({ ...input, employeeId: "employee" })).toMatchObject({
      code: "FORBIDDEN",
      reason: "OPERATOR_SESSION_REQUIRED",
    });
    db.stationLogonSession.findMany.mockResolvedValueOnce([session, { ...session, id: "second" }]);
    expect(await resolveActionActor({ ...input, employeeId: "employee" })).toMatchObject({
      reason: "OPERATOR_SESSION_AMBIGUOUS",
    });
  });
  it("rejects mismatched raw id alongside session proof", async () => {
    expect(await resolveActionActor({ ...input, operatorSessionId: "session", employeeId: "colleague" })).toMatchObject(
      { code: "FORBIDDEN", reason: "OPERATOR_EMPLOYEE_MISMATCH" },
    );
  });
  it("rechecks employee and site access for every attributed action", async () => {
    db.employee.findUnique.mockResolvedValueOnce({ workspaceId: "workspace", status: "INACTIVE" });
    expect(await resolveActionActor({ ...input, operatorSessionId: "session" })).toMatchObject({
      reason: "EMPLOYEE_INACTIVE",
    });
    db.employeeSiteAccess.findUnique.mockResolvedValueOnce(null);
    expect(await resolveActionActor({ ...input, operatorSessionId: "session" })).toMatchObject({
      reason: "EMPLOYEE_SITE_ACCESS_INACTIVE",
    });
  });
  it("checks current qualifications rather than session-time role", async () => {
    expect(await actorRoleAllowed("employee", "site", [{ id: "former-role" }])).toBe(false);
    expect(await actorRoleAllowed("employee", "site", [{ id: "qualified" }])).toBe(true);
  });
  it("USER cannot choose a colleague to pass a role gate", async () => {
    expect(await resolveActionActor({ ...input, userId: "user", employeeId: "colleague" })).toMatchObject({
      code: "FORBIDDEN",
      reason: "ACCOUNT_EMPLOYEE_MISMATCH",
    });
    expect(await resolveActionActor({ ...input, userId: "user" })).toMatchObject({
      userId: "user",
      employeeId: "employee",
      assurance: "ACCOUNT",
    });
  });
  it("an optional employee link outside this plant does not block account-user actions", async () => {
    db.employeeSiteAccess.findUnique.mockResolvedValue(null);
    expect(await resolveActionActor({ ...input, userId: "user" })).toMatchObject({
      userId: "user",
      employeeId: null,
      employeeVersionId: null,
      assurance: "ACCOUNT",
    });
    expect(await resolveActionActor({ ...input, userId: "user", employeeId: "employee" })).toMatchObject({
      code: "FORBIDDEN",
      reason: "EMPLOYEE_SITE_ACCESS_INACTIVE",
    });
  });
});

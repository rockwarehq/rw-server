import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  role: { findUnique: vi.fn() },
  workcenter: { findUnique: vi.fn() },
  site: { findUnique: vi.fn() },
  workspaceMembership: { findUnique: vi.fn() },
  roleAssignment: { create: vi.fn() },
}));
vi.mock("@rw/db", () => ({ default: db }));
import { assign, ScopeMismatchError, SystemUserAssignmentError } from "./assignments.js";

beforeEach(() => {
  vi.resetAllMocks();
  db.user.findUnique.mockResolvedValue({ id: "user", systemRole: null });
  db.role.findUnique.mockResolvedValue({
    id: "role",
    workspaceId: "workspace",
    scope: "WORKCENTER",
    permissions: ["production:admin"],
  });
  db.workcenter.findUnique.mockResolvedValue({ siteId: "site-a", site: { workspaceId: "workspace" } });
  db.site.findUnique.mockResolvedValue({ workspaceId: "workspace" });
  db.workspaceMembership.findUnique.mockResolvedValue({ id: "membership" });
  db.roleAssignment.create.mockImplementation(async ({ data }) => ({ id: "assignment", ...data }));
});

describe("workcenter custom-role assignment invariants", () => {
  it("derives the site from the WC and saves the exact production-only role scope", async () => {
    expect(await assign({ userId: "user", roleId: "role", workcenterId: "wc" })).toMatchObject({
      membershipId: "membership",
      roleId: "role",
      siteId: "site-a",
      workcenterId: "wc",
    });
    expect(db.workspaceMembership.findUnique).toHaveBeenCalledWith({
      where: { userId_workspaceId: { userId: "user", workspaceId: "workspace" } },
      select: { id: true },
    });
  });

  it("rejects a forged site/WC pair before creating an assignment", async () => {
    await expect(assign({ userId: "user", roleId: "role", siteId: "site-b", workcenterId: "wc" })).rejects.toThrow(
      ScopeMismatchError,
    );
    expect(db.roleAssignment.create).not.toHaveBeenCalled();
  });

  it("rejects WCs in a different workspace and non-member recipients", async () => {
    db.workcenter.findUnique.mockResolvedValueOnce({ siteId: "site-a", site: { workspaceId: "other" } });
    await expect(assign({ userId: "user", roleId: "role", workcenterId: "wc" })).rejects.toThrow(/workspace/);
    db.workspaceMembership.findUnique.mockResolvedValueOnce(null);
    await expect(assign({ userId: "user", roleId: "role", workcenterId: "wc" })).rejects.toThrow(/membership/);
    expect(db.roleAssignment.create).not.toHaveBeenCalled();
  });

  it("requires an existing WC and refuses malformed broad WC role permissions", async () => {
    await expect(assign({ userId: "user", roleId: "role" })).rejects.toThrow(/requires a workcenterId/);
    db.workcenter.findUnique.mockResolvedValueOnce(null);
    await expect(assign({ userId: "user", roleId: "role", workcenterId: "wc" })).rejects.toThrow(/not found/);
    db.role.findUnique.mockResolvedValueOnce({
      workspaceId: "workspace",
      scope: "WORKCENTER",
      permissions: ["plant:admin"],
    });
    await expect(assign({ userId: "user", roleId: "role", workcenterId: "wc" })).rejects.toThrow(
      /only contain production/,
    );
    expect(db.roleAssignment.create).not.toHaveBeenCalled();
  });

  it.each(["SITE", "WORKSPACE"])("%s roles cannot acquire WC scope by passing a WC id", async (scope) => {
    db.role.findUnique.mockResolvedValue({ workspaceId: "workspace", scope, permissions: ["production:read"] });
    await expect(
      assign({ userId: "user", roleId: "role", siteId: scope === "SITE" ? "site-a" : null, workcenterId: "wc" }),
    ).rejects.toThrow(ScopeMismatchError);
    expect(db.roleAssignment.create).not.toHaveBeenCalled();
  });

  it("keeps legacy SITE and WORKSPACE assignments explicitly nullable", async () => {
    db.role.findUnique.mockResolvedValueOnce({
      workspaceId: "workspace",
      scope: "SITE",
      permissions: ["planning:read"],
    });
    expect(await assign({ userId: "user", roleId: "role", siteId: "site-a" })).toMatchObject({
      siteId: "site-a",
      workcenterId: null,
    });
    db.role.findUnique.mockResolvedValueOnce({
      workspaceId: "workspace",
      scope: "WORKSPACE",
      permissions: ["owner:all"],
    });
    expect(await assign({ userId: "user", roleId: "role" })).toMatchObject({ siteId: null, workcenterId: null });
  });

  it("never assigns customer roles to internal staff", async () => {
    db.user.findUnique.mockResolvedValueOnce({ id: "user", systemRole: "ENGINEER" });
    await expect(assign({ userId: "user", roleId: "role", workcenterId: "wc" })).rejects.toThrow(
      SystemUserAssignmentError,
    );
    expect(db.roleAssignment.create).not.toHaveBeenCalled();
  });
});

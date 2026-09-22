import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAMContext } from "@rw/auth/context";

const mocks = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(),
    create: vi.fn(), update: vi.fn(), deleteMany: vi.fn(), findUniqueOrThrow: vi.fn(),
  });
  const db = {
    user: model(), workspace: model(), workspaceMembership: model(), role: model(),
    roleAssignment: model(), workcenterGrant: model(), site: model(), workcenter: model(),
    employee: model(), employeeRole: model(), employeeVersion: model(), station: model(), gateway: model(), datasource: model(),
    $transaction: vi.fn(),
  };
  return { db, hasPermission: vi.fn(), employeeUpdate: vi.fn(), employeeRemove: vi.fn(), employeeGet: vi.fn(),
     stationCreate: vi.fn(), stationMove: vi.fn(), stationRemove: vi.fn(), jobList: vi.fn(), jobCreate: vi.fn(), orderCreate: vi.fn(),
     rolesList: vi.fn(), gatewayUpdate: vi.fn(), gatewayList: vi.fn(), gatewayTokenCreate: vi.fn(), datasourceCreate: vi.fn(), datasourceAssign: vi.fn() };
});

vi.mock("@rw/db", () => ({ default: mocks.db, Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } } }));
vi.mock("@rw/auth/iam/index", async () => ({
  ...await import("../../../packages/auth/src/iam/permissions.js"),
  hasPermission: mocks.hasPermission,
  roles: { list: mocks.rolesList },
  hasAnyPermission: async (id: string, permissions: string[], scope: unknown) => {
    for (const permission of permissions) if (await mocks.hasPermission(id, permission, scope)) return true;
    return false;
  },
}));
vi.mock("@rw/auth/iam/policy", async () => import("../../../packages/auth/src/iam/policy.js"));
vi.mock("@rw/auth/iam/roles", () => ({ findSystemRole: vi.fn() }));
vi.mock("@rw/services/audit/index", () => ({ logEvent: vi.fn() }));
vi.mock("@rw/services/entity/events", () => ({ publishEntityEvent: vi.fn() }));
vi.mock("@rw/services/notification/consent", () => ({ consentByPhone: vi.fn(async () => new Map()) }));
vi.mock("@rw/auth/password", () => ({ hashPassword: vi.fn() }));
vi.mock("@rw/services/facility/index", () => ({ station: { create: mocks.stationCreate, move: mocks.stationMove, remove: mocks.stationRemove } }));
vi.mock("../src/services/device/index.js", () => ({
  gateway: { update: mocks.gatewayUpdate, list: mocks.gatewayList, tokens: { create: mocks.gatewayTokenCreate } },
  datasource: { create: mocks.datasourceCreate, assign: mocks.datasourceAssign },
}));
vi.mock("@rw/services/job/index", () => ({ job: { list: mocks.jobList, create: mocks.jobCreate }, tool: {} }));
vi.mock("@rw/services/order/order", () => ({ create: mocks.orderCreate }));
vi.mock("../src/services/account/user/avatar.js", () => ({ resolveAvatarUrl: vi.fn() }));
vi.mock("../src/services/employee/logon.js", () => ({ publishStationCurrentLogonsMetric: vi.fn() }));
vi.mock("../src/services/employee/index.js", () => ({
  crud: { update: mocks.employeeUpdate, remove: mocks.employeeRemove, getById: mocks.employeeGet },
  smsConsent: {},
}));
vi.mock("../src/rpc/middleware.js", () => {
  const procedure = { input: () => procedure, handler: (handler: unknown) => handler };
  return { authRequired: procedure, userOrDisplayRequired: procedure };
});
vi.mock("../src/services/account/index.js", async () => ({
  user: await import("../src/services/account/user/crud.js"),
  workspace: {
    ...await import("../src/services/account/workspace/members.js"),
    exists: vi.fn(async () => true),
    update: mocks.db.workspace.update,
    remove: vi.fn(),
  },
}));

import { snapshotHasPermission } from "../../../packages/auth/src/iam/permissions.js";
import workspaceRoutes from "../src/api/workspaces.js";
import stationRoutes from "../src/api/stations.js";
import gatewayRoutes from "../src/api/gateways.js";
import datasourceRoutes from "../src/api/datasources.js";
import * as members from "../src/services/account/workspace/members.js";
import * as users from "../src/services/account/user/crud.js";
import * as employeeRpc from "../src/rpc/employee.js";
import * as employeeCrud from "../src/services/employee/crud.js";
import * as jobRpc from "../src/rpc/job.js";
import * as orderRpc from "../src/rpc/order.js";
import * as workspaceRpc from "../src/rpc/workspace.js";
import * as deviceRpc from "../src/rpc/device.js";
import * as workcenterCrud from "../../../packages/services/src/facility/workcenter/crud.js";
import { siteUpdatePermissions } from "../../../packages/services/src/facility/site/settings.js";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const siteA = "20000000-0000-4000-8000-000000000001";
const siteB = "20000000-0000-4000-8000-000000000002";
const targetId = "30000000-0000-4000-8000-000000000001";
const roleId = "40000000-0000-4000-8000-000000000001";

function context(permissions: string[], siteId: string | null = siteA): IAMContext {
  return {
    id: "actor", validToken: true, principal: "USER", workspaceId, siteId: siteA,
    permissionSnapshot: { systemRole: null, assignments: [{ siteId, permissions }] },
  } as IAMContext;
}

let actor: IAMContext;
beforeEach(() => {
  vi.resetAllMocks();
  actor = context(["plant:admin"]);
  mocks.hasPermission.mockImplementation(async (_id, permission, scope) =>
    scope.workspaceId === workspaceId && snapshotHasPermission(actor.permissionSnapshot!, permission, scope.siteId, scope.workcenterId));
  mocks.db.$transaction.mockImplementation(async (fn) => fn(mocks.db));
  mocks.db.workspaceMembership.findMany.mockResolvedValue([]);
  mocks.db.user.findMany.mockResolvedValue([]);
  mocks.db.user.count.mockResolvedValue(0);
  mocks.db.roleAssignment.findMany.mockResolvedValue([]);
  mocks.db.site.findUnique.mockResolvedValue({ workspaceId });
});

async function workspaceServer() {
  const server = Fastify();
  server.decorate("verifyAccessToken", async (request: { iam?: IAMContext }) => { request.iam = actor; });
  await server.register(workspaceRoutes as never, { prefix: "/workspaces" });
  await server.ready();
  return server;
}

describe("workspace REST authority", () => {
  it.each([
    ["PUT", { name: "unauthorized" }],
    ["DELETE", undefined],
  ] as const)("%s ignores the token's site grant", async (method, payload) => {
    const server = await workspaceServer();
    try {
      const response = await server.inject({ method, url: `/workspaces/${workspaceId}`, payload });
      expect(response.statusCode).toBe(403);
      expect(mocks.db.workspace.update).not.toHaveBeenCalled();
      expect(mocks.hasPermission).toHaveBeenCalledWith("actor", method === "DELETE" ? "owner:all" : "plant:admin", {
        workspaceId, siteId: undefined,
      });
    } finally { await server.close(); }
  });

  it("allows a workspace administrator to update its workspace", async () => {
    actor = context(["plant:admin"], null);
    mocks.db.workspace.update.mockResolvedValue({ id: workspaceId, name: "Updated" });
    const server = await workspaceServer();
    try {
      const response = await server.inject({ method: "PUT", url: `/workspaces/${workspaceId}`, payload: { name: "Updated" } });
      expect(response.statusCode).toBe(200);
      expect(mocks.db.workspace.update).toHaveBeenCalledWith(workspaceId, { name: "Updated" });
    } finally { await server.close(); }
  });

  it("rejects a different URL workspace before checking authority", async () => {
    actor = context(["plant:admin", "owner:all"], null);
    const server = await workspaceServer();
    try {
      const response = await server.inject({ method: "DELETE", url: `/workspaces/${siteB}` });
      expect(response.statusCode).toBe(403);
      expect(mocks.hasPermission).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it("addMember requires workspace authority and protects owner assignment", async () => {
    mocks.db.role.findUnique.mockResolvedValue({ id: roleId, workspaceId, scope: "WORKSPACE", isSystem: true, permissions: ["owner:all"] });
    await expect(members.addMember(workspaceId, targetId, roleId, "actor")).rejects.toThrow("Forbidden");
    actor = context(["plant:admin"], null);
    await expect(members.addMember(workspaceId, targetId, roleId, "actor")).rejects.toThrow("owner:all");
    expect(mocks.db.workspaceMembership.create).not.toHaveBeenCalled();
  });
});

describe("user population boundaries", () => {
  it("applies the same workspace/site population predicate to roster rows and count", async () => {
    await users.list({ workspaceId, siteId: siteA });
    const rowWhere = mocks.db.user.findMany.mock.calls[0][0].where;
    expect(rowWhere).toEqual({ systemRole: null, memberships: { some: members.memberPopulationWhere(workspaceId, siteA) } });
    expect(mocks.db.user.count).toHaveBeenCalledWith({ where: rowWhere });
    expect(rowWhere.memberships.some.OR).toContainEqual({ workcenterGrants: { some: { workcenter: { siteId: siteA } } } });
  });

  it("does not allow a plant admin to look up a target outside its population", async () => {
    mocks.db.workspaceMembership.findFirst.mockResolvedValue(null);
    expect(await users.authorizeTarget(actor, targetId)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mocks.db.workspaceMembership.findFirst.mock.calls[0][0].where).toEqual({
      ...members.memberPopulationWhere(workspaceId, siteA), userId: targetId,
    });
  });

  it("global user changes require workspace authority even for a member of the current plant", async () => {
    expect(await users.authorizeTarget(actor, targetId, true)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(mocks.db.workspaceMembership.findFirst).not.toHaveBeenCalled();
  });

  it("rejects global changes to a user shared with a company the actor cannot administer", async () => {
    actor = context(["plant:admin"], null);
    mocks.db.workspaceMembership.findFirst.mockResolvedValue({ id: "membership" });
    mocks.db.workspaceMembership.findMany.mockResolvedValue([
      { workspaceId, roleAssignments: [] }, { workspaceId: "another-workspace", roleAssignments: [] },
    ]);
    expect(await users.authorizeTarget(actor, targetId, true)).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("owner targets require owner authority for global edits", async () => {
    actor = context(["plant:admin"], null);
    mocks.db.workspaceMembership.findFirst.mockResolvedValue({ id: "membership" });
    mocks.db.workspaceMembership.findMany.mockResolvedValue([{ workspaceId, roleAssignments: [{ role: { permissions: ["owner:all"] } }] }]);
    expect(await users.authorizeTarget(actor, targetId, true)).toMatchObject({ ok: false, message: "Owner permission required" });
  });
});

describe("custom workcenter role assignment", () => {
  it("a plant administrator can discover custom WORKCENTER roles", async () => {
    mocks.rolesList.mockResolvedValue([{ id: roleId, name: "Line lead", scope: "WORKCENTER", permissions: ["production:admin"] }]);
    expect(await invoke(workspaceRpc.listUserRoles, {})).toMatchObject({ data: [{ scope: "WORKCENTER", permissions: ["production:admin"] }] });
    expect(mocks.rolesList).toHaveBeenCalledWith(workspaceId);
  });

  it("the workspace response retains WORKCENTER role scope and its binding", async () => {
    mocks.db.workspaceMembership.findMany.mockResolvedValue([{
      workspace: { id: workspaceId, name: "Company", slug: "company", description: null },
      joinedAt: new Date(), employee: null,
      roleAssignments: [{ id: roleId, siteId: siteA, workcenterId: targetId, site: { id: siteA, name: "A" }, role: { id: roleId, name: "Line lead", isSystem: false, scope: "WORKCENTER", permissions: ["production:admin"] } }],
      workcenterGrants: [],
    }]);
    const server = await workspaceServer();
    try {
      const response = await server.inject({ method: "GET", url: "/workspaces/" });
      expect(response.statusCode).toBe(200);
      expect(response.json()[0].roleAssignments[0]).toMatchObject({ siteId: siteA, workcenterId: targetId, role: { scope: "WORKCENTER" } });
      expect(response.json()[0].access.sitePermissions[0].permissions).toEqual([]);
    } finally { await server.close(); }
  });

  it("summaries evaluate implications within scope and do not promote workcenter grants", async () => {
    mocks.db.workspaceMembership.findMany.mockResolvedValue([{
      workspaceId,
      roleAssignments: [
        { id: "site-role", siteId: siteA, workcenterId: null, site: { id: siteA, name: "A" }, role: { id: roleId, name: "Planner", isSystem: false, scope: "SITE", permissions: ["planning:write"] } },
        { id: "wc-role", siteId: siteA, workcenterId: "wc-1", site: { id: siteA, name: "A" }, role: { id: "role-2", name: "Production", isSystem: false, scope: "WORKCENTER", permissions: ["production:admin"] } },
      ], workcenterGrants: [],
    }]);
    const summary = (await members.getWorkspaceAccessSummaries(targetId, [workspaceId])).get(workspaceId)!;
    expect(summary.access.workspacePermissions).toEqual([]);
    expect(summary.access.sitePermissions[0].permissions).toEqual(["planning:read", "planning:write"]);
    expect(summary.access.sites).toEqual({ all: false, siteIds: [siteA] });
    expect(summary.roleAssignments[1].workcenterId).toBe("wc-1");
  });

  it("replaces only the requested workcenter assignment, preserving site and sibling roles", async () => {
    mocks.db.role.findUnique.mockResolvedValue({ id: roleId, workspaceId, scope: "WORKCENTER", isSystem: false, permissions: ["production:write"] });
    mocks.db.site.findUnique.mockResolvedValue({ workspaceId });
    mocks.db.workcenter.findUnique.mockResolvedValue({ siteId: siteA, site: { workspaceId } });
    mocks.db.workspaceMembership.findUnique.mockResolvedValue({ id: "membership" });
    mocks.db.workspaceMembership.findUniqueOrThrow.mockResolvedValue({ id: "membership" });
    const result = await members.updateRole({ actorUserId: "actor", targetUserId: targetId, workspaceId, siteId: siteA, workcenterId: "wc-1", roleId });
    expect(result.success).toBe(true);
    expect(mocks.db.roleAssignment.deleteMany).toHaveBeenCalledWith({ where: { membershipId: "membership", siteId: siteA, workcenterId: "wc-1" } });
    expect(mocks.db.roleAssignment.create).toHaveBeenCalledWith({ data: { membershipId: "membership", siteId: siteA, workcenterId: "wc-1", roleId } });
  });

  it("rejects workcenter roles without a workcenter and cross-site destinations", async () => {
    mocks.db.role.findUnique.mockResolvedValue({ id: roleId, workspaceId, scope: "WORKCENTER", isSystem: false, permissions: ["production:read"] });
    const input = { actorUserId: "actor", targetUserId: targetId, workspaceId, siteId: siteA, roleId };
    expect(await members.updateRole(input)).toMatchObject({ success: false, code: "WORKCENTER_CONTEXT_REQUIRED" });
    mocks.db.site.findUnique.mockResolvedValue({ workspaceId });
    mocks.db.workcenter.findUnique.mockResolvedValue({ siteId: siteB, site: { workspaceId } });
    expect(await members.updateRole({ ...input, workcenterId: "wc-b" })).toMatchObject({ success: false, code: "WORKCENTER_MISMATCH" });
    expect(mocks.db.roleAssignment.deleteMany).not.toHaveBeenCalled();
  });

  it("replacing a SITE role never deletes custom WORKCENTER assignments", async () => {
    mocks.db.role.findUnique.mockResolvedValue({ id: roleId, workspaceId, scope: "SITE", isSystem: false, permissions: ["planning:read"] });
    mocks.db.workspaceMembership.findUnique.mockResolvedValue({ id: "membership" });
    mocks.db.workspaceMembership.findUniqueOrThrow.mockResolvedValue({ id: "membership" });
    await members.updateRole({ actorUserId: "actor", targetUserId: targetId, workspaceId, siteId: siteA, roleId });
    expect(mocks.db.roleAssignment.deleteMany).toHaveBeenCalledWith({ where: { membershipId: "membership", siteId: siteA, workcenterId: null } });
  });

  it("derives the plant from a WORKCENTER assignment without requiring active-site context", async () => {
    actor = { ...context(["plant:admin"], null), siteId: undefined };
    mocks.db.role.findUnique.mockResolvedValue({ id: roleId, workspaceId, scope: "WORKCENTER", isSystem: false, permissions: ["production:read"] });
    mocks.db.workcenter.findUnique.mockResolvedValue({ siteId: siteB, site: { workspaceId } });
    mocks.db.workspaceMembership.findUnique.mockResolvedValue({ id: "membership" });
    mocks.db.workspaceMembership.findUniqueOrThrow.mockResolvedValue({ id: "membership" });
    const result = await members.updateRole({ actorUserId: "actor", targetUserId: targetId, workspaceId, workcenterId: "wc-b", roleId });
    expect(result.success).toBe(true);
    expect(mocks.db.roleAssignment.create).toHaveBeenCalledWith({ data: { membershipId: "membership", siteId: siteB, workcenterId: "wc-b", roleId } });
  });

  it("the last plant admin guard checks SITE plant:admin with no workcenter binding", async () => {
    mocks.db.role.findUnique.mockResolvedValue({ id: roleId, workspaceId, scope: "SITE", isSystem: false, permissions: ["planning:read"] });
    mocks.db.workspaceMembership.findUnique.mockResolvedValue({ id: "membership" });
    mocks.db.roleAssignment.findMany.mockResolvedValue([{ siteId: siteA, workcenterId: null, role: { isSystem: false, scope: "SITE", permissions: ["plant:admin"] } }]);
    mocks.db.workspaceMembership.findFirst.mockResolvedValue(null);
    const result = await members.updateRole({ actorUserId: "actor", targetUserId: targetId, workspaceId, siteId: siteA, roleId });
    expect(result).toMatchObject({ success: false, code: "LAST_SITE_ADMIN" });
    expect(mocks.db.workspaceMembership.findFirst.mock.calls[0][0].where.roleAssignments.some).toEqual({
      siteId: siteA, workcenterId: null, role: { scope: "SITE", permissions: { has: "plant:admin" } },
    });
    expect(mocks.db.roleAssignment.deleteMany).not.toHaveBeenCalled();
  });
});

type Handler = (args: { input: Record<string, unknown>; context: { iam: IAMContext } }) => Promise<unknown>;
const invoke = (handler: unknown, input: Record<string, unknown>) => (handler as Handler)({ input, context: { iam: actor } });

describe("employee target and shared-profile boundaries", () => {
  it("requires target access in the authorized site, not any site", async () => {
    mocks.db.employee.findUnique.mockResolvedValue(null);
    await expect(invoke(employeeRpc.get, { id: targetId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.db.employee.findUnique.mock.calls[0][0].where).toEqual({ id: targetId, workspaceId, siteAccess: { some: { siteId: siteA } } });
    expect(mocks.employeeGet).not.toHaveBeenCalled();
  });

  it.each([{ pin: "1234" }, { firstName: "Changed" }, { status: "INACTIVE" }])("blocks a shared profile change without authority over every affected plant: %j", async (patch) => {
    mocks.db.employee.findUnique.mockResolvedValue({ siteAccess: [{ siteId: siteA }, { siteId: siteB }] });
    await expect(invoke(employeeRpc.update, { id: targetId, ...patch })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.employeeUpdate).not.toHaveBeenCalled();
  });

  it("permits a role-only edit in its plant without changing the shared profile", async () => {
    mocks.db.employee.findUnique.mockResolvedValue({ siteAccess: [{ siteId: siteA }, { siteId: siteB }] });
    mocks.employeeUpdate.mockResolvedValue({ data: { id: targetId } });
    await invoke(employeeRpc.update, { id: targetId, roleId });
    expect(mocks.employeeUpdate).toHaveBeenCalledWith(targetId, { roleId }, expect.objectContaining({ workspaceId, siteId: siteA }));
  });

  it("the CRUD service rejects role assignment into another plant", async () => {
    mocks.db.employee.findUnique.mockResolvedValue({ id: targetId, workspaceId, version: { version: 1 } });
    mocks.db.employeeRole.findUnique.mockResolvedValue({ id: roleId, siteId: siteB, site: { workspaceId } });
    expect(await employeeCrud.update(targetId, { roleId }, { workspaceId, siteId: siteA })).toMatchObject({ code: "WORKSPACE_MISMATCH" });
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });

  it("cannot delete an employee shared with another plant", async () => {
    mocks.db.employee.findUnique.mockResolvedValue({ siteAccess: [{ siteId: siteA }, { siteId: siteB }] });
    await expect(invoke(employeeRpc.remove, { id: targetId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.employeeRemove).not.toHaveBeenCalled();
  });
});

describe("site preference authority", () => {
  it("separates administration from generic technical attrs and access preferences", () => {
    expect(siteUpdatePermissions({ name: "Plant" })).toEqual(["plant:admin"]);
    expect(siteUpdatePermissions({ attrs: { operator: { allowChangeJob: true } } })).toEqual(["configuration:write"]);
    expect(siteUpdatePermissions({ attrs: { baseWorkcenterAccess: "ALL" } })).toEqual(["configuration:write", "plant:admin"]);
  });
});

describe("planning and production references", () => {
  it("a planner can read reusable jobs but cannot modify them", async () => {
    actor = context(["planning:write"]);
    mocks.jobList.mockResolvedValue({ data: [] });
    await invoke(jobRpc.list, { siteId: siteA });
    expect(mocks.jobList).toHaveBeenCalledWith({ siteId: siteA });
    await expect(invoke(jobRpc.create, { siteId: siteA, name: "Job" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    mocks.orderCreate.mockResolvedValue({ data: { id: "order" } });
    await invoke(orderRpc.create, { siteId: siteA, name: "Order" });
    expect(mocks.orderCreate).toHaveBeenCalled();
  });

  it("a workcenter writer cannot create reusable jobs or orders", async () => {
    actor = { ...context([]), permissionSnapshot: { systemRole: null, assignments: [], workcenterGrants: [{ siteId: siteA, workcenterId: "wc-1", access: "WRITE" }] } };
    await expect(invoke(jobRpc.create, { siteId: siteA, name: "Job" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(invoke(orderRpc.create, { siteId: siteA, name: "Order" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.jobCreate).not.toHaveBeenCalled();
    expect(mocks.orderCreate).not.toHaveBeenCalled();
  });

  it("workcenter rows and totals are both narrowed to the proven workcenter set", async () => {
    mocks.db.workcenter.findMany.mockResolvedValue([]);
    mocks.db.workcenter.count.mockResolvedValue(0);
    await workcenterCrud.list({ workspaceId, siteId: siteA, workcenterIds: ["wc-1"] });
    const where = { siteId: siteA, site: { workspaceId }, id: { in: ["wc-1"] } };
    expect(mocks.db.workcenter.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(mocks.db.workcenter.count).toHaveBeenCalledWith({ where });
  });
});

describe("REST station destinations", () => {
  it("returns CONFLICT when a display-bound station cannot be deleted", async () => {
    actor = context(["configuration:write"]);
    mocks.db.station.findUnique.mockResolvedValue({ siteId: siteA, workcenterId: "wc-a" });
    mocks.stationRemove.mockResolvedValue({ error: "Station is bound to a display", code: "DISPLAY_STATION_BOUND" });
    const server = Fastify();
    server.decorate("verifyAccessToken", async (request: { iam?: IAMContext }) => { request.iam = actor; });
    await server.register(stationRoutes as never, { prefix: "/stations" });
    try {
      const response = await server.inject({ method: "DELETE", url: `/stations/${targetId}` });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "Station is bound to a display" });
    } finally { await server.close(); }
  });

  it("a workspace grant cannot create a station in a foreign company's plant", async () => {
    actor = context(["configuration:write"], null);
    mocks.db.site.findUnique.mockResolvedValue({ workspaceId: "foreign-company" });
    const server = Fastify();
    server.decorate("verifyAccessToken", async (request: { iam?: IAMContext }) => { request.iam = actor; });
    await server.register(stationRoutes as never, { prefix: "/stations" });
    try {
      const response = await server.inject({ method: "POST", url: "/stations/", payload: { name: "Station", siteId: siteB } });
      expect(response.statusCode).toBe(403);
      expect(mocks.stationCreate).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it.each(["create", "move"])("%s authorizes the destination plant before calling the service", async (operation) => {
    actor = context(["configuration:write"]);
    mocks.db.workcenter.findUnique.mockResolvedValue({ siteId: siteB, id: targetId });
    mocks.db.station.findUnique.mockResolvedValue({ siteId: siteA, workcenterId: "wc-a" });
    const server = Fastify();
    server.decorate("verifyAccessToken", async (request: { iam?: IAMContext }) => { request.iam = actor; });
    await server.register(stationRoutes as never, { prefix: "/stations" });
    try {
      const response = await server.inject({
        method: "POST", url: operation === "create" ? "/stations/" : `/stations/${targetId}/move`,
        payload: operation === "create" ? { name: "Station", siteId: siteA, workcenterId: targetId } : { workcenterId: targetId },
      });
      expect(response.statusCode).toBe(403);
      expect(mocks.stationCreate).not.toHaveBeenCalled();
      expect(mocks.stationMove).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
});

describe("equipment commissioning boundaries", () => {
  it("a site engineer may list unassigned hardware and assign it to its authorized plant", async () => {
    actor = context(["configuration:write"]);
    mocks.gatewayList.mockResolvedValue([]);
    await invoke(deviceRpc.gatewayList, { unassigned: true, siteId: siteA });
    expect(mocks.gatewayList).toHaveBeenCalledWith({ workspaceId, unassigned: true });
    mocks.db.gateway.findUnique.mockResolvedValue({ siteId: null });
    mocks.gatewayUpdate.mockResolvedValue({ data: { id: targetId } });
    await invoke(deviceRpc.gatewayUpdate, { id: targetId, siteId: siteA });
    expect(mocks.gatewayUpdate).toHaveBeenCalledWith(targetId, { siteId: siteA, workspaceId });
  });

  it("an unassigned gateway cannot be edited using unrelated site authority", async () => {
    actor = context(["configuration:write"]);
    mocks.db.gateway.findUnique.mockResolvedValue({ siteId: null });
    await expect(invoke(deviceRpc.gatewayUpdate, { id: targetId, name: "No destination" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.gatewayUpdate).not.toHaveBeenCalled();
  });

  it("an unassigned gateway's credentials require workspace authority", async () => {
    actor = context(["configuration:write"]);
    mocks.db.gateway.findUnique.mockResolvedValue({ siteId: null });
    const server = Fastify();
    server.decorate("verifyAccessToken", async (request: { iam?: IAMContext }) => { request.iam = actor; });
    await server.register(gatewayRoutes as never, { prefix: "/gateways" });
    try {
      const response = await server.inject({ method: "POST", url: `/gateways/${targetId}/tokens`, payload: {} });
      expect(response.statusCode).toBe(403);
      expect(mocks.gatewayTokenCreate).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it.each(["REST", "RPC"])("%s datasource creation authorizes the attached gateway too", async (surface) => {
    actor = context(["configuration:write"]);
    mocks.db.gateway.findUnique.mockResolvedValue({ siteId: siteB });
    const input = { siteId: siteA, name: "Datasource", driver: "modbus", gatewayId: targetId };
    if (surface === "RPC") {
      await expect(invoke(deviceRpc.datasourceCreate, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    } else {
      const server = Fastify();
      server.decorate("verifyAccessToken", async (request: { iam?: IAMContext }) => { request.iam = actor; });
      await server.register(datasourceRoutes as never, { prefix: "/datasources" });
      try {
        expect((await server.inject({ method: "POST", url: "/datasources/", payload: input })).statusCode).toBe(403);
      } finally { await server.close(); }
    }
    expect(mocks.datasourceCreate).not.toHaveBeenCalled();
  });

  it("a workspace grant still cannot configure another company's gateway", async () => {
    actor = context(["configuration:write"], null);
    mocks.db.gateway.findUnique.mockResolvedValue({ siteId: siteB });
    mocks.db.site.findUnique.mockResolvedValue({ workspaceId: "foreign-company" });
    await expect(invoke(deviceRpc.gatewayUpdate, { id: targetId, name: "Foreign gateway" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.gatewayUpdate).not.toHaveBeenCalled();
  });
});

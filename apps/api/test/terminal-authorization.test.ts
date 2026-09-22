import { call as rpc, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAMContext } from "@rw/auth/context";

const db = vi.hoisted(() => ({
  display: { findUnique: vi.fn() }, station: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  workcenter: { findUnique: vi.fn() }, stationStateLog: { findUnique: vi.fn() },
  call: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  stationLogonSession: { findUnique: vi.fn(), findMany: vi.fn() },
  employee: { findUnique: vi.fn() }, employeeSiteAccess: { findUnique: vi.fn() }, workspaceMembership: { findUnique: vi.fn() },
  productMaterialAltGroup: { findUnique: vi.fn() }, productMaterial: { findUnique: vi.fn() },
  product: { findUnique: vi.fn() }, inventoryItem: { findMany: vi.fn(), count: vi.fn() },
  shiftInstance: { findUnique: vi.fn() }, shiftComment: { create: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
}));
const services = vi.hoisted(() => ({
  call: { open: vi.fn(), close: vi.fn(), listActive: vi.fn() },
  productionMode: { force: vi.fn(), clear: vi.fn() },
  station: { create: vi.fn(), move: vi.fn(), changeJob: vi.fn(), splitDownEntry: vi.fn(), assignDowntimeReason: vi.fn(), list: vi.fn() },
  product: { setAltGroupActive: vi.fn(), update: vi.fn() },
  dispositionLog: { record: vi.fn() },
  amendJobHistory: vi.fn(),
}));
vi.mock("@rw/db", () => ({ default: db }));
vi.mock("@rw/services/facility/index", () => services);
vi.mock("@rw/services/inventory/index", () => ({ product: services.product }));
vi.mock("@rw/services/inventory/disposition", () => ({}));
vi.mock("@rw/services/inventory/disposition-reason", () => ({}));
vi.mock("@rw/services/inventory/disposition-log", () => services.dispositionLog);
vi.mock("@rw/services/history/index", () => ({ amendJobHistory: services.amendJobHistory, listAmendments: vi.fn(), retryRebuild: vi.fn() }));
vi.mock("@rw/services/order/coverage", () => ({ getProductStockSummary: vi.fn() }));
vi.mock("../src/rpc/middleware.js", async () => {
  const { os } = await import("@orpc/server");
  const base = os.$context<{ iam: IAMContext }>();
  const authRequired = base.use(({ context, next }) => {
    if (!context.iam.validToken || context.iam.principal !== "USER") throw new ORPCError("UNAUTHORIZED");
    return next({ context });
  });
  return { authRequired, userOrDisplayRequired: base, processorRequired: base };
});

import * as calls from "../src/rpc/call.js";
import * as modes from "../src/rpc/production-mode.js";
import * as stations from "../src/rpc/station.js";
import * as inventory from "../src/rpc/inventory.js";
import * as disposition from "../src/rpc/disposition.js";
import * as recap from "../src/rpc/shift-recap.js";
import { hasProductionAdmin } from "../src/rpc/terminal-authz.js";
import { authorize } from "@rw/auth/iam/policy";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const site = id(1), workspace = id(2), display = id(3), stationA = id(4), stationB = id(5), wcA = id(6), wcB = id(7), employee = id(8), sessionId = id(9), commentId = id(10), userId = id(11), shift = id(12), groupId = id(13), memberId = id(14), callId = id(15);
const terminal: IAMContext = { principal: "DISPLAY", validToken: true, displayId: display, siteId: site, workspaceId: workspace };
const user = (permissions: string[], workcenterId?: string, siteId = site): IAMContext => ({
  principal: "USER", validToken: true, id: userId, workspaceId: workspace, siteId: site,
  permissionSnapshot: { systemRole: null, assignments: [{ siteId, ...(workcenterId ? { workcenterId } : {}), permissions }] },
});
const loc = { siteId: site, workcenterId: wcA, stationId: stationA };
const commentInput = { siteId: site, shiftInstanceId: shift, workCenterId: wcA, stationId: stationA, text: "Shift note" };
let boundStation: string | null;
let comment: Record<string, unknown>;

beforeEach(() => {
  vi.resetAllMocks();
  boundStation = stationA;
  comment = { id: commentId, ...loc, shiftInstanceId: shift, deletedAt: null, authorKind: "DISPLAY", authorId: display, createdById: null };
  db.display.findUnique.mockImplementation(async () => ({ id: display, status: "CLAIMED", siteId: site, stationId: boundStation, workcenterId: wcA, site: { workspaceId: workspace } }));
  db.station.findUnique.mockImplementation(async ({ where }) => ({ id: where.id, siteId: site, workcenterId: where.id === stationA ? wcA : wcB }));
  db.workcenter.findUnique.mockResolvedValue({ siteId: site });
  db.stationStateLog.findUnique.mockResolvedValue({ ...loc, station: { id: stationA, siteId: site, workcenterId: wcA } });
  db.call.findUnique.mockResolvedValue({ ...loc, station: { id: stationA, siteId: site, workcenterId: wcA } });
  db.call.findMany.mockResolvedValue([]);
  db.call.count.mockResolvedValue(0);
  db.inventoryItem.findMany.mockResolvedValue([]);
  db.inventoryItem.count.mockResolvedValue(0);
  db.stationLogonSession.findUnique.mockResolvedValue({ id: sessionId, employeeId: employee, displayId: display, siteId: site, stationId: stationA, logoffTime: null, logonMethod: "PIN", station: { siteId: site } });
  db.stationLogonSession.findMany.mockResolvedValue([]);
  db.employee.findUnique.mockResolvedValue({ id: employee, status: "ACTIVE", workspaceId: workspace, versionId: id(20) });
  db.employeeSiteAccess.findUnique.mockResolvedValue({ status: "ACTIVE", roleId: id(21), employee: { status: "ACTIVE" }, role: { siteId: site } });
  db.workspaceMembership.findUnique.mockResolvedValue(null);
  db.productMaterialAltGroup.findUnique.mockResolvedValue({ productId: id(30), product: { siteId: site } });
  db.productMaterial.findUnique.mockResolvedValue({ productId: id(30), altGroupId: groupId });
  db.product.findUnique.mockResolvedValue({ siteId: site });
  db.shiftInstance.findUnique.mockResolvedValue({ siteId: site, workCenterId: null });
  db.shiftComment.findUnique.mockImplementation(async () => comment);
  db.shiftComment.findFirst.mockImplementation(async () => comment);
  db.shiftComment.findMany.mockResolvedValue([]);
  db.shiftComment.create.mockImplementation(async ({ data }) => ({ id: commentId, ...data, createdBy: null, authorDisplay: { name: "Terminal" }, authorEmployee: null }));
  db.shiftComment.update.mockImplementation(async ({ data }) => ({ ...comment, ...data, createdBy: null, authorDisplay: { name: "Terminal" }, authorEmployee: null }));
  services.call.open.mockResolvedValue({ data: { id: callId }, deduped: false });
  services.call.close.mockResolvedValue({ data: { id: callId } });
  services.productionMode.force.mockResolvedValue({ data: { id: id(40) } });
  services.productionMode.clear.mockResolvedValue({ data: {} });
  services.station.changeJob.mockResolvedValue({ data: { stationId: stationA } });
  services.station.create.mockResolvedValue({ data: { id: stationA } });
  services.station.move.mockResolvedValue({ data: { id: stationA } });
  services.station.splitDownEntry.mockResolvedValue({ success: true, entries: [{}, {}] });
  services.station.assignDowntimeReason.mockResolvedValue({ success: true });
  services.amendJobHistory.mockResolvedValue({ data: { amendmentId: id(41) } });
  services.product.setAltGroupActive.mockResolvedValue({ data: { id: groupId } });
  services.dispositionLog.record.mockResolvedValue({ data: { id: id(60) } });
});

describe("terminal RPC authorization", () => {
  it("preserves basic operations for old tokens without any operator identity", async () => {
    const context = { iam: terminal };
    await rpc(stations.changeJob, { stationId: stationA, jobId: id(50) }, { context });
    await rpc(stations.splitDowntime, { entryId: id(51), splitAt: new Date() }, { context });
    await rpc(stations.assignDowntimeReason, { entryId: id(51), statusReasonId: null }, { context });
    await rpc(calls.open, { stationId: stationA, definitionId: id(52) }, { context });
    await rpc(modes.force, { stationId: stationA, modeId: id(53) }, { context });
    expect(services.call.open).toHaveBeenCalledWith(expect.objectContaining({ openedByEmployeeId: undefined }));
    expect(services.productionMode.force).toHaveBeenCalledWith(expect.objectContaining({ bypassRoles: false, employeeId: undefined }));
  });
  it("rejects fixed-terminal writes to a sibling station", async () => {
    await expect(rpc(stations.changeJob, { stationId: stationB, jobId: null }, { context: { iam: terminal } })).rejects.toMatchObject({ code: "FORBIDDEN", data: { reason: "TERMINAL_STATION_MISMATCH" } });
    expect(services.station.changeJob).not.toHaveBeenCalled();
  });
  it("scrap recording needs no employee but validates the station and product site", async () => {
    const input = { siteId: site, stationId: stationA, productId: id(30), itemDispositionId: id(61), dispositionReasonId: id(62) };
    await rpc(disposition.logRecord, input, { context: { iam: terminal } });
    expect(services.dispositionLog.record).toHaveBeenCalledWith(input);
    await expect(rpc(disposition.logRecord, { ...input, stationId: stationB }, { context: { iam: terminal } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    db.product.findUnique.mockResolvedValue({ siteId: id(99) });
    await expect(rpc(disposition.logRecord, input, { context: { iam: terminal } })).rejects.toMatchObject({ code: "FORBIDDEN", data: { reason: "RELATED_RESOURCE_SITE_MISMATCH" } });
    expect(services.dispositionLog.record).toHaveBeenCalledTimes(1);
  });
  it("roaming identity follows selected station, without changing attendance", async () => {
    boundStation = null;
    await rpc(modes.force, { stationId: stationB, modeId: id(53), operatorSessionId: sessionId }, { context: { iam: terminal } });
    expect(services.productionMode.force).toHaveBeenCalledWith(expect.objectContaining({ stationId: stationB, employeeId: employee, bypassRoles: false }));
    await rpc(stations.amendJobHistory, { stationId: stationB, jobId: id(54), from: new Date(), to: null, operatorSessionId: sessionId }, { context: { iam: terminal } });
    expect(services.amendJobHistory).toHaveBeenCalledWith(expect.objectContaining({ stationId: stationB, actor: { employeeId: employee, userId: undefined } }));
  });
  it("raw employeeId needs a matching active session and invalid attribution is 403 with a reason", async () => {
    const input = { stationId: stationA, definitionId: id(52), employeeId: employee };
    await expect(rpc(calls.open, input, { context: { iam: terminal } })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403, data: { reason: "OPERATOR_SESSION_REQUIRED" } });
    db.stationLogonSession.findMany.mockResolvedValue([await db.stationLogonSession.findUnique()]);
    await rpc(calls.open, input, { context: { iam: terminal } });
    expect(services.call.open).toHaveBeenCalledWith(expect.objectContaining({ openedByEmployeeId: employee }));
  });
  it("DISPLAY has no generic write or admin bypass, including call close", async () => {
    expect(await authorize(terminal, { permission: "production:write", scope: { kind: "site", siteId: site } })).toMatchObject({ ok: false });
    expect(await hasProductionAdmin(terminal, loc)).toBe(false);
    await rpc(calls.close, { id: callId }, { context: { iam: terminal } });
    expect(services.call.close).toHaveBeenCalledWith(expect.objectContaining({ bypassAnswerRoles: false }));
  });
  it("only account administrators with the correct location may bypass", async () => {
    expect(await hasProductionAdmin(user(["production:admin"], wcA), loc)).toBe(true);
    expect(await hasProductionAdmin(user(["production:admin"], wcB), loc)).toBe(false);
    expect(await hasProductionAdmin(user(["plant:admin"], undefined, id(99)), loc)).toBe(false);
    expect(await hasProductionAdmin(user(["production:admin"], wcA, id(99)), loc)).toBe(false);
    expect(await hasProductionAdmin({ ...terminal, permissionSnapshot: user(["production:admin"], wcA).permissionSnapshot }, loc)).toBe(false);
    expect(await hasProductionAdmin(user(["production:admin"], wcA), { siteId: site, workcenterId: null })).toBe(false);
  });
  it("station create and move match REST: site configuration write and same-site destination resolution", async () => {
    const create = { siteId: site, workcenterId: wcA, name: "Station" };
    const move = { id: stationA, workcenterId: wcB };
    const context = { iam: user(["configuration:write"]) };
    await rpc(stations.create, create, { context });
    await rpc(stations.move, move, { context });
    expect(services.station.create).toHaveBeenCalledWith(create);
    expect(services.station.move).toHaveBeenCalledWith(stationA, wcB, workspace);
    for (const iam of [user(["production:write"], wcA), user(["configuration:write"], wcA)]) {
      await expect(rpc(stations.create, create, { context: { iam } })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(rpc(stations.move, move, { context: { iam } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    db.workcenter.findUnique.mockResolvedValue({ siteId: id(99) });
    await expect(rpc(stations.create, create, { context })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rpc(stations.move, move, { context })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const bothSites: IAMContext = { ...context.iam, permissionSnapshot: { systemRole: null, assignments: [
      { siteId: site, permissions: ["configuration:write"] },
      { siteId: id(99), permissions: ["configuration:write"] },
    ] } };
    await expect(rpc(stations.create, create, { context: { iam: bothSites } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(rpc(stations.move, move, { context: { iam: bothSites } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(services.station.create).toHaveBeenCalledTimes(1);
    expect(services.station.move).toHaveBeenCalledTimes(1);
  });
  it("preserves the shared-plant alternate selector without adding a station argument", async () => {
    await rpc(inventory.productSetAltGroupActive, { altGroupId: groupId, productMaterialId: memberId }, { context: { iam: terminal } });
    expect(services.product.setAltGroupActive).toHaveBeenCalledWith(groupId, memberId);
    db.productMaterial.findUnique.mockResolvedValue({ productId: id(31), altGroupId: groupId });
    await expect(rpc(inventory.productSetAltGroupActive, { altGroupId: groupId, productMaterialId: memberId }, { context: { iam: terminal } })).rejects.toMatchObject({ code: "FORBIDDEN", data: { reason: "ALTERNATE_MEMBERSHIP_REQUIRED" } });
    await expect(rpc(inventory.productUpdate, { id: id(30), name: "Catalog edit" }, { context: { iam: terminal } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("the alternate exception is site-bound and does not extend WC account grants to product writes", async () => {
    const input = { altGroupId: groupId, productMaterialId: memberId };
    await expect(rpc(inventory.productSetAltGroupActive, input, { context: { iam: user(["production:write"], wcA) } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    db.productMaterialAltGroup.findUnique.mockResolvedValue({ productId: id(30), product: { siteId: id(99) } });
    await expect(rpc(inventory.productSetAltGroupActive, input, { context: { iam: terminal } })).rejects.toMatchObject({ code: "FORBIDDEN", data: { reason: "TERMINAL_SITE_MISMATCH" } });
  });
  it("USER WC list filters apply before pagination and exclude null-WC facts", async () => {
    const context = { iam: user(["production:read"], wcA) };
    const callsPage = await rpc(calls.listActive, { siteId: site, limit: 10, offset: 5 }, { context });
    expect(callsPage).toEqual({ data: [], total: 0, limit: 10, offset: 5 });
    expect(db.call.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ siteId: site, workcenterId: { in: [wcA] } }), take: 10, skip: 5 }));
    expect(db.call.count).toHaveBeenCalledWith({ where: db.call.findMany.mock.calls[0][0].where });
    await rpc(inventory.inventoryList, { siteId: site, limit: 10, offset: 5 }, { context });
    expect(db.inventoryItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ cycle: { siteId: site, workcenterId: { in: [wcA] } } }), take: 10, skip: 5 }));
  });
});

describe("shift comment identity and scope", () => {
  it("creates a terminal-owned comment without employee identification", async () => {
    const result = await rpc(recap.commentCreate, commentInput, { context: { iam: terminal } });
    expect(result).toMatchObject({ createdById: null, author: { kind: "DISPLAY", id: display, assurance: "TERMINAL" }, sourceDisplayId: display });
  });
  it("preserves USER createdBy and provides an author DTO", async () => {
    const result = await rpc(recap.commentCreate, commentInput, { context: { iam: user(["production:write"], wcA) } });
    expect(result).toMatchObject({ createdById: userId, author: { kind: "USER", id: userId } });
  });
  it("records employee author independently from source display", async () => {
    const result = await rpc(recap.commentCreate, { ...commentInput, operatorSessionId: sessionId }, { context: { iam: terminal } });
    expect(result).toMatchObject({ author: { kind: "EMPLOYEE", id: employee, assurance: "VERIFIED" }, sourceDisplayId: display, operatorSessionId: sessionId });
  });
  it("captures a USER's linked employee and permits that verified person to edit from another allowed terminal", async () => {
    db.workspaceMembership.findUnique.mockResolvedValue({ employeeId: employee, employee: { versionId: id(20), status: "ACTIVE" } });
    const iam = user(["production:write"], wcA);
    const created = await rpc(recap.commentCreate, commentInput, { context: { iam } });
    expect(created).toMatchObject({ createdById: userId, authorKind: "USER", authorId: userId, authorEmployeeId: employee });
    comment = { ...comment, ...created };
    boundStation = null;
    const otherDisplay = id(70);
    const operator = { ...terminal, displayId: otherDisplay };
    db.display.findUnique.mockResolvedValue({ id: otherDisplay, status: "CLAIMED", siteId: site, stationId: null, workcenterId: wcB, site: { workspaceId: workspace } });
    db.stationLogonSession.findUnique.mockResolvedValue({
      id: sessionId, employeeId: employee, displayId: otherDisplay, siteId: site,
      stationId: stationB, station: { siteId: site }, logoffTime: null, logonMethod: "PIN",
    });
    await rpc(recap.commentUpdate, { id: commentId, text: "Verified person edit", operatorSessionId: sessionId }, { context: { iam: operator } });
    expect(db.shiftComment.update).toHaveBeenCalledWith(expect.objectContaining({ data: { text: "Verified person edit" } }));
    // A recorded Employee author is also the same person when using their linked USER account.
    comment = { ...comment, authorKind: "EMPLOYEE", authorId: employee };
    await rpc(recap.commentUpdate, { id: commentId, text: "Account edit" }, { context: { iam } });
    await expect(rpc(recap.commentUpdate, { id: commentId, text: "Impersonation", employeeId: id(71) }, { context: { iam } })).rejects.toMatchObject({ code: "FORBIDDEN", data: { reason: "ACCOUNT_EMPLOYEE_MISMATCH" } });
  });
  it("source terminal alone cannot edit a person-owned comment", async () => {
    comment = { ...comment, authorKind: "EMPLOYEE", authorId: employee, sourceDisplayId: display };
    await expect(rpc(recap.commentUpdate, { id: commentId, text: "edit" }, { context: { iam: terminal } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.shiftComment.update).not.toHaveBeenCalled();
    await rpc(recap.commentUpdate, { id: commentId, text: "edit", operatorSessionId: sessionId }, { context: { iam: terminal } });
    expect(db.shiftComment.update).toHaveBeenCalledWith(expect.objectContaining({ data: { text: "edit" } }));
  });
  it("unknown legacy authors never become editable, even by administrators", async () => {
    comment = { ...comment, authorKind: "UNKNOWN", authorId: null };
    await expect(rpc(recap.commentUpdate, { id: commentId, text: "edit" }, { context: { iam: user(["production:admin"]) } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    comment = { ...comment, authorKind: "USER", authorId: id(98) };
    await expect(rpc(recap.commentUpdate, { id: commentId, text: "edit" }, { context: { iam: user(["production:admin"]) } })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("author has no delete right; scoped USER admin soft-deletes and records deleting user", async () => {
    comment = { ...comment, authorKind: "USER", authorId: userId, createdById: userId };
    for (const iam of [user(["production:write"], wcA), user(["production:admin"], wcB), user(["plant:admin"], undefined, id(99))]) {
      await expect(rpc(recap.commentDelete, { id: commentId }, { context: { iam } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await rpc(recap.commentDelete, { id: commentId }, { context: { iam: user(["production:admin"], wcA) } });
    expect(db.shiftComment.update).toHaveBeenCalledWith(expect.objectContaining({ data: { deletedAt: expect.any(Date), deletedById: userId } }));
  });
  it("site Plant Admin and site production admin can delete without authorship", async () => {
    for (const permission of ["plant:admin", "production:admin"]) {
      await rpc(recap.commentDelete, { id: commentId }, { context: { iam: user([permission]) } });
    }
    expect(db.shiftComment.update).toHaveBeenCalledTimes(2);
  });
  it("fixed-terminal comment reads preserve site-wide access while USER WC scope still applies", async () => {
    const input = { siteId: site, shiftInstanceId: shift, workCenterId: wcA };
    await rpc(recap.commentList, input, { context: { iam: terminal } });
    expect(db.shiftComment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { siteId: site, shiftInstanceId: shift, workcenterId: wcA, deletedAt: null } }));
    await rpc(recap.commentList, { ...input, workCenterId: wcB }, { context: { iam: terminal } });
    await expect(rpc(recap.commentList, { ...input, workCenterId: wcB }, { context: { iam: user(["production:read"], wcA) } })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("validates WC/site/shift links and limits fixed terminals' WC-wide comments", async () => {
    await rpc(recap.commentCreate, { ...commentInput, stationId: null }, { context: { iam: terminal } });
    await expect(rpc(recap.commentCreate, { ...commentInput, stationId: null, workCenterId: wcB }, { context: { iam: terminal } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    db.shiftInstance.findUnique.mockResolvedValue({ siteId: site, workCenterId: wcB });
    await expect(rpc(recap.commentCreate, commentInput, { context: { iam: terminal } })).rejects.toBeInstanceOf(ORPCError);
  });
});

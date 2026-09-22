import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import { createAccessToken, hashToken, verifyAccessToken } from "@rw/auth/tokens";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

type Device = { id: string; token: string; legacyToken: string; secret: string };
type Account = { id: string; token: string };
type Comment = {
  id: string;
  createdById: string | null;
  createdBy: { id: string } | null;
  author: { kind: string; id: string | null; employeeId: string | null; assurance: string | null };
  sourceDisplayId: string | null;
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("terminal compatibility against PostgreSQL", () => {
  const suffix = randomUUID();
  const siteIds: string[] = [];
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const employeeIds: string[] = [];
  const displayIds: string[] = [];
  let server: TestServer;
  let workspaceId: string;
  let siteId: string, otherSiteId: string, wcA: string, wcB: string, wcOther: string;
  let stationA: string, stationB: string, stationOther: string, shiftId: string;
  let employeeId: string, unrelatedEmployeeId: string, qualifiedRole: string, otherRole: string;
  let fixed: Device, roaming: Device, verified: Device;
  let fixedSession: string, roamingSession: string, verifiedSession: string;
  let writer: Account, wcAdmin: Account, wrongWcAdmin: Account, plantAdmin: Account, foreignAdmin: Account, engineer: Account, manager: Account;
  let jobId: string, productId: string, altGroupId: string, firstMaterialId: string, alternateMaterialId: string, outsiderMaterialId: string;
  let restrictedDefinition: string, basicDefinition: string, modeId: string;

  async function request<T = unknown>(path: string, input: unknown, token: string, status = 200): Promise<T> {
    const result = await rpcCall(server, path, input, token);
    expect(result.statusCode, `${path}: ${JSON.stringify(result.json)}`).toBe(status);
    return result.json as T;
  }

  async function account(name: string, roleId: string, scopeSiteId = siteId, workcenterId?: string, linkedEmployeeId?: string): Promise<Account> {
    const user = await prisma.user.create({ data: { email: `${name}-${suffix}@test.local`, status: "ACTIVE", firstName: name } });
    userIds.push(user.id);
    const membership = await prisma.workspaceMembership.create({ data: { workspaceId, userId: user.id, employeeId: linkedEmployeeId } });
    await prisma.roleAssignment.create({ data: { membershipId: membership.id, roleId, siteId: scopeSiteId, workcenterId } });
    return { id: user.id, token: createAccessToken({ id: user.id, email: user.email, workspaceId, siteId: scopeSiteId }) };
  }

  async function role(name: string, permissions: string[], scope: "SITE" | "WORKCENTER" = "SITE") {
    const row = await prisma.role.create({ data: { workspaceId, name: `${name}-${suffix}`, scope, permissions } });
    roleIds.push(row.id);
    return row.id;
  }

  async function device(name: string, stationId: string | null): Promise<Device> {
    const secret = randomUUID();
    const row = await prisma.display.create({ data: {
      name: `${name}-${suffix}`, status: "CLAIMED", siteId, stationId, workcenterId: wcA,
      bootstrapSecretHash: hashToken(secret),
    } });
    displayIds.push(row.id);
    const response = await server.inject({ method: "POST", url: "/auth/display/login", payload: { displayId: row.id, bootstrapSecret: secret } });
    expect(response.statusCode, response.body).toBe(200);
    const login = response.json<{ accessToken: string; refreshToken: string; display: { id: string; stationId: string | null } }>();
    expect(login.display).toMatchObject({ id: row.id, stationId });
    expect(login.refreshToken).toEqual(expect.any(String));
    // The pre-existing payload has no station, mode, monitor, or employee claim.
    const legacyToken = createAccessToken({ principal: "DISPLAY", displayId: row.id, workspaceId, siteId });
    expect(verifyAccessToken(legacyToken)).not.toHaveProperty("stationId");
    return { id: row.id, token: login.accessToken, legacyToken, secret };
  }

  async function logon(display: Device, method: "EMPLOYEE_ID" | "PIN", stationId = stationA) {
    const response = await request<{ session: { id: string; employeeId: string; stationId: string }; activeSessions: unknown[] }>("operator/logon", {
      displayId: display.id, stationId, method, credentials: { employeeId, ...(method === "PIN" ? { pin: "123456" } : {}) },
    }, display.token);
    expect(response.session).toMatchObject({ employeeId, stationId });
    return response.session.id;
  }

  async function newComment(token = fixed.token, extras: Record<string, unknown> = {}): Promise<Comment> {
    return request<Comment>("shiftRecap/commentCreate", {
      siteId, shiftInstanceId: shiftId, workCenterId: wcA, stationId: stationA, text: `Note ${randomUUID()}`, ...extras,
    }, token);
  }

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    workspaceId = (await prisma.workspace.findFirstOrThrow({ select: { id: true } })).id;
    for (const name of ["Terminal plant", "Other terminal plant"]) {
      siteIds.push((await prisma.site.create({ data: { workspaceId, name: `${name}-${suffix}`, timezone: "UTC" } })).id);
    }
    [siteId, otherSiteId] = siteIds;
    wcA = (await prisma.workcenter.create({ data: { siteId, name: "A" } })).id;
    wcB = (await prisma.workcenter.create({ data: { siteId, name: "B" } })).id;
    wcOther = (await prisma.workcenter.create({ data: { siteId: otherSiteId, name: "Other" } })).id;
    stationA = (await prisma.station.create({ data: { siteId, workcenterId: wcA, name: "A" } })).id;
    stationB = (await prisma.station.create({ data: { siteId, workcenterId: wcB, name: "B" } })).id;
    stationOther = (await prisma.station.create({ data: { siteId: otherSiteId, workcenterId: wcOther, name: "Other" } })).id;
    const pattern = await prisma.shiftPattern.create({ data: { siteId, name: "Test shifts" } });
    const definition = await prisma.shiftDefinition.create({ data: { patternId: pattern.id, dayOfRotation: 1, sortOrder: 1, startTime: "00:00", durationHrs: 24, shiftName: "Test shift" } });
    const start = new Date(Date.now() - 6 * 3_600_000);
    const assignment = await prisma.shiftAssignment.create({ data: { siteId, patternId: pattern.id, rotationStartDate: start } });
    shiftId = (await prisma.shiftInstance.create({ data: { siteId, assignmentId: assignment.id, definitionId: definition.id, shiftName: "Test shift", businessDate: start, startTime: start, endTime: new Date(Date.now() + 6 * 3_600_000) } })).id;
    qualifiedRole = (await prisma.employeeRole.create({ data: { siteId, name: "Qualified" } })).id;
    otherRole = (await prisma.employeeRole.create({ data: { siteId, name: "Other qualification" } })).id;
    for (const firstName of ["Operator", "Unrelated"]) {
      const employee = await prisma.employee.create({ data: { workspaceId, status: "ACTIVE" } });
      employeeIds.push(employee.id);
      const version = await prisma.employeeVersion.create({ data: { employeeId: employee.id, version: 1, firstName, lastName: suffix, pinHash: await hashPassword("123456") } });
      await prisma.employee.update({ where: { id: employee.id }, data: { versionId: version.id } });
      await prisma.employeeSiteAccess.create({ data: { employeeId: employee.id, siteId, roleId: qualifiedRole, status: "ACTIVE" } });
    }
    [employeeId, unrelatedEmployeeId] = employeeIds;
    writer = await account("writer", await role("Writer", ["production:write"]), siteId, undefined, employeeId);
    const adminRole = await role("WC administrator", ["production:admin"], "WORKCENTER");
    wcAdmin = await account("wc-admin", adminRole, siteId, wcA);
    wrongWcAdmin = await account("other-wc-admin", adminRole, siteId, wcB);
    const plantRole = await role("Plant administration only", ["plant:admin"]);
    plantAdmin = await account("plant-admin", plantRole);
    foreignAdmin = await account("foreign-admin", plantRole, otherSiteId);
    manager = await account("configuration-manager", await role("Configuration manager", ["configuration:write"]));
    const engineerRole = await prisma.role.findUniqueOrThrow({ where: { workspaceId_name_scope: { workspaceId, name: "Plant Engineer", scope: "SITE" } } });
    expect(engineerRole.permissions).toContain("production:admin");
    expect(engineerRole.permissions).not.toContain("plant:admin");
    engineer = await account("plant-engineer", engineerRole.id);
    fixed = await device("Fixed", stationA);
    roaming = await device("Roaming", null);
    verified = await device("Verified employee terminal", null);
    fixedSession = await logon(fixed, "EMPLOYEE_ID");
    roamingSession = await logon(roaming, "EMPLOYEE_ID");
    verifiedSession = await logon(verified, "PIN", stationB);
    restrictedDefinition = (await prisma.callDefinition.create({ data: { siteId, name: "Restricted", openRoles: { connect: { id: qualifiedRole } }, answerRoles: { connect: { id: qualifiedRole } } } })).id;
    basicDefinition = (await prisma.callDefinition.create({ data: { siteId, name: "Basic" } })).id;
    modeId = (await prisma.productionMode.create({ data: { siteId, name: "Operator mode", roles: { connect: { id: qualifiedRole } } } })).id;
    const job = await prisma.job.create({ data: { siteId } });
    jobId = job.id;
    const jobVersion = await prisma.jobVersion.create({ data: { jobId, version: 1, name: "Historical job", standardCycle: 30 } });
    await prisma.job.update({ where: { id: jobId }, data: { currentVersionId: jobVersion.id } });
    productId = (await prisma.product.create({ data: { siteId } })).id;
    altGroupId = (await prisma.productMaterialAltGroup.create({ data: { productId } })).id;
    const members: string[] = [];
    for (let i = 0; i < 3; i++) {
      const material = await prisma.material.create({ data: { siteId } });
      members.push((await prisma.productMaterial.create({ data: { productId, materialId: material.id, altGroupId: i < 2 ? altGroupId : null } })).id);
    }
    [firstMaterialId, alternateMaterialId, outsiderMaterialId] = members;
    await prisma.productMaterialAltGroup.update({ where: { id: altGroupId }, data: { activeProductMaterialId: firstMaterialId } });
  }, 60_000);

  afterAll(async () => {
    // Every delete is confined to this fixture's ids/sites. Seeded workspace and roles survive.
    if (siteIds.length) {
      const site = { siteId: { in: siteIds } };
      await prisma.shiftComment.deleteMany({ where: site });
      await prisma.shiftSignoff.deleteMany({ where: site });
      await prisma.display.deleteMany({ where: site });
      await prisma.call.deleteMany({ where: site });
      await prisma.stationModeLog.deleteMany({ where: site });
      await prisma.station.deleteMany({ where: site });
      await prisma.callDefinition.deleteMany({ where: site });
      await prisma.productionMode.deleteMany({ where: site });
      await prisma.job.updateMany({ where: site, data: { currentVersionId: null } });
      await prisma.jobVersion.deleteMany({ where: { job: site } });
      await prisma.job.deleteMany({ where: site });
      await prisma.productMaterialAltGroup.updateMany({ where: { product: site }, data: { activeProductMaterialId: null } });
      await prisma.productMaterialAltGroup.deleteMany({ where: { product: site } });
      await prisma.productMaterial.deleteMany({ where: { product: site } });
      await prisma.product.deleteMany({ where: site });
      await prisma.material.deleteMany({ where: site });
      await prisma.shiftInstance.deleteMany({ where: site });
      await prisma.shiftAssignment.deleteMany({ where: site });
      await prisma.shiftDefinition.deleteMany({ where: { pattern: site } });
      await prisma.shiftPattern.deleteMany({ where: site });
      await prisma.workspaceMembership.updateMany({ where: { userId: { in: userIds } }, data: { employeeId: null } });
      await prisma.auditLog.deleteMany({ where: { OR: [
        { userId: { in: userIds } }, { actorId: { in: userIds } },
        ...displayIds.map((id) => ({ metadata: { path: ["displayId"], equals: id } })),
      ] } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
      await prisma.employeeRole.deleteMany({ where: site });
      await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
      await prisma.workcenter.deleteMany({ where: site });
      await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
    }
    await server?.close();
  }, 60_000);

  it("existing device credentials and old-shaped tokens preserve fixed/site-free mutation behavior", async () => {
    const config = await request<{ requireLogon: boolean }>("operator/config", { displayId: fixed.id }, fixed.legacyToken);
    expect(config.requireLogon).toBe(false);
    await request("station/changeJob", { stationId: stationA, jobId }, fixed.legacyToken);
    await request("station/changeJob", { stationId: stationB, jobId }, fixed.legacyToken, 403);
    await request("station/changeJob", { stationId: stationB, jobId }, roaming.legacyToken);
    await request("station/changeJob", { stationId: stationOther, jobId }, roaming.legacyToken, 403);
    expect((await prisma.station.findUniqueOrThrow({ where: { id: stationB } })).currentJobId).toBe(jobId);
    expect((await prisma.display.findUniqueOrThrow({ where: { id: roaming.id } })).workcenterId).toBe(wcA);
  });

  it("fixed display dashboards and pickers retain site-wide reads", async () => {
    const stations = await request<{ data: Array<{ id: string }> }>("station/list", { siteId, limit: 0 }, fixed.token);
    expect(stations.data.map((s) => s.id)).toEqual(expect.arrayContaining([stationA, stationB]));
    expect(stations.data.map((s) => s.id)).not.toContain(stationOther);
    const call = await request<{ id: string }>("call/open", { stationId: stationB, definitionId: basicDefinition }, roaming.token);
    const page = await request<{ data: Array<{ id: string }> }>("call/listActive", { siteId, stationId: stationB }, fixed.token);
    expect(page.data.map((c) => c.id)).toContain(call.id);
    await request("call/get", { id: call.id }, fixed.legacyToken);
    const note = await newComment(roaming.token, { workCenterId: wcB, stationId: stationB });
    const notes = await request<Comment[]>("shiftRecap/commentList", { siteId, shiftInstanceId: shiftId, workCenterId: wcB }, fixed.token);
    expect(notes.map((c) => c.id)).toContain(note.id);
    await request("shiftRecap/commentUpdate", { id: note.id, text: "Cross-station edit" }, fixed.token, 403);
    await request("station/list", { siteId: otherSiteId }, fixed.token, 403);
  });

  it("unidentified basic comments belong to the display and only that author may edit", async () => {
    const note = await newComment(fixed.legacyToken);
    expect(note).toMatchObject({ createdById: null, createdBy: null, sourceDisplayId: fixed.id, author: { kind: "DISPLAY", id: fixed.id, assurance: "TERMINAL" } });
    await request("shiftRecap/commentUpdate", { id: note.id, text: "Own terminal edit" }, fixed.token);
    await request("shiftRecap/commentUpdate", { id: note.id, text: "Same terminal after identification", operatorSessionId: fixedSession }, fixed.token);
    await request("shiftRecap/commentUpdate", { id: note.id, text: "Other terminal" }, roaming.token, 403);
    // Existing USER-only middleware uses 401 for an unsupported principal.
    await request("shiftRecap/commentDelete", { id: note.id }, fixed.token, 401);
    await newComment(fixed.token, { stationId: null });
    await request("shiftRecap/commentCreate", { siteId, shiftInstanceId: shiftId, workCenterId: wcB, stationId: null, text: "Wrong WC" }, fixed.token, 403);
  });

  it("restricted calls never gain DISPLAY admin bypass; identified eligible operators are allowed", async () => {
    const open = { stationId: stationA, definitionId: restrictedDefinition };
    await request("call/open", open, fixed.token, 403);
    const call = await request<{ id: string; openedByEmployeeId: string }>("call/open", { ...open, employeeId }, fixed.token);
    expect(call.openedByEmployeeId).toBe(employeeId);
    await request("call/close", { id: call.id }, fixed.token, 403);
    const closed = await request<{ closedByEmployeeId: string }>("call/close", { id: call.id, operatorSessionId: fixedSession }, fixed.token);
    expect(closed.closedByEmployeeId).toBe(employeeId);
  });

  it("active operator identity follows station selection without moving attendance", async () => {
    const call = await request<{ id: string; stationId: string; openedByEmployeeId: string }>("call/open", {
      stationId: stationB, definitionId: restrictedDefinition, operatorSessionId: roamingSession,
    }, roaming.token);
    expect(call).toMatchObject({ stationId: stationB, openedByEmployeeId: employeeId });
    await request("productionMode/force", { stationId: stationB, modeId, operatorSessionId: roamingSession }, roaming.token);
    const attendance = await prisma.stationLogonSession.findUniqueOrThrow({ where: { id: roamingSession } });
    expect(attendance).toMatchObject({ stationId: stationA, displayId: roaming.id, siteId, logoffTime: null });
    await request("call/close", { id: call.id, operatorSessionId: roamingSession }, roaming.token);
    await request("productionMode/clear", { stationId: stationB, operatorSessionId: roamingSession }, roaming.token);
  });

  it("unrelated raw employee ids and foreign sessions fail with 403 machine reasons", async () => {
    const open = { stationId: stationA, definitionId: basicDefinition };
    const unrelated = await request<{ data: { reason: string } }>("call/open", { ...open, employeeId: unrelatedEmployeeId }, fixed.token, 403);
    expect(unrelated.data.reason).toBe("OPERATOR_SESSION_REQUIRED");
    const foreign = await request<{ data: { reason: string } }>("call/open", { ...open, operatorSessionId: roamingSession }, fixed.token, 403);
    expect(foreign.data.reason).toBe("OPERATOR_SESSION_INVALID");
    const account = await request<{ data: { reason: string } }>("call/open", { ...open, employeeId: unrelatedEmployeeId }, writer.token, 403);
    expect(account.data.reason).toBe("ACCOUNT_EMPLOYEE_MISMATCH");
  });

  it("active sessions recheck current qualification and employee site access", async () => {
    try {
      await prisma.employeeSiteAccess.update({ where: { employeeId_siteId: { employeeId, siteId } }, data: { roleId: otherRole } });
      await request("call/open", { stationId: stationA, definitionId: restrictedDefinition, operatorSessionId: fixedSession }, fixed.token, 403);
      await prisma.employeeSiteAccess.update({ where: { employeeId_siteId: { employeeId, siteId } }, data: { status: "INACTIVE" } });
      const response = await request<{ data: { reason: string } }>("call/open", { stationId: stationA, definitionId: basicDefinition, operatorSessionId: fixedSession }, fixed.token, 403);
      expect(response.data.reason).toBe("EMPLOYEE_SITE_ACCESS_INACTIVE");
    } finally {
      await prisma.employeeSiteAccess.update({ where: { employeeId_siteId: { employeeId, siteId } }, data: { roleId: qualifiedRole, status: "ACTIVE" } });
    }
  });

  it("person-owned comments follow identified identity rather than source display, with no mandatory PIN", async () => {
    const note = await newComment(roaming.token, { operatorSessionId: roamingSession });
    expect(note.author).toMatchObject({ kind: "EMPLOYEE", id: employeeId, assurance: "IDENTIFIED" });
    await request("shiftRecap/commentUpdate", { id: note.id, text: "Source only" }, roaming.token, 403);
    await request("shiftRecap/commentUpdate", { id: note.id, text: "Identified author", operatorSessionId: roamingSession }, roaming.token);
    await request("shiftRecap/commentUpdate", { id: note.id, text: "Verified person", operatorSessionId: verifiedSession }, verified.token);
    await request("shiftRecap/commentUpdate", { id: note.id, text: "Linked account" }, writer.token);
    const accountNote = await newComment(writer.token);
    expect(accountNote).toMatchObject({ createdById: writer.id, createdBy: { id: writer.id }, author: { kind: "USER", id: writer.id, employeeId } });
    await request("shiftRecap/commentUpdate", { id: accountNote.id, text: "Same person through terminal", operatorSessionId: verifiedSession }, verified.token);
    await expect(prisma.shiftComment.update({ where: { id: accountNote.id }, data: { authorEmployeeId: unrelatedEmployeeId } })).rejects.toThrow(/immutable/i);
    const stored = await prisma.shiftComment.findUniqueOrThrow({ where: { id: accountNote.id } });
    expect(stored).toMatchObject({ createdById: writer.id, authorKind: "USER", authorId: writer.id, authorEmployeeId: employeeId });
  });

  it("legacy USER and unknown comment authors retain safe ownership and no invented verification", async () => {
    const legacy = await prisma.shiftComment.create({ data: { siteId, workcenterId: wcA, stationId: stationA, shiftInstanceId: shiftId, text: "Legacy USER", createdById: writer.id, authorKind: "USER", authorId: writer.id } });
    await request("shiftRecap/commentUpdate", { id: legacy.id, text: "Account author" }, writer.token);
    await request("shiftRecap/commentUpdate", { id: legacy.id, text: "Current employee link", operatorSessionId: verifiedSession }, verified.token, 403);
    const unknown = await prisma.shiftComment.create({ data: { siteId, workcenterId: wcA, shiftInstanceId: shiftId, text: "Unknown legacy author" } });
    await request("shiftRecap/commentUpdate", { id: unknown.id, text: "Admin override" }, engineer.token, 403);
    expect((await prisma.shiftComment.findUniqueOrThrow({ where: { id: legacy.id } })).authorAssurance).toBeNull();
    await expect(prisma.shiftComment.update({ where: { id: legacy.id }, data: { authorId: engineer.id } })).rejects.toThrow(/immutable/i);
  });

  it("deletion requires scoped production/plant administration, including Plant Engineer, not authorship or manage", async () => {
    const own = await newComment(writer.token);
    for (const actor of [writer, manager, wrongWcAdmin, foreignAdmin]) {
      await request("shiftRecap/commentDelete", { id: own.id }, actor.token, 403);
    }
    for (const actor of [wcAdmin, plantAdmin, engineer]) {
      const note = await newComment();
      await request("shiftRecap/commentDelete", { id: note.id }, actor.token);
      const deleted = await prisma.shiftComment.findUniqueOrThrow({ where: { id: note.id } });
      expect(deleted.deletedAt).toBeInstanceOf(Date);
      expect(deleted.deletedById).toBe(actor.id);
    }
  });

  it("historical job corrections remain available without identity or a new terminal claim", async () => {
    const result = await request<{ amendmentId: string; currentJobChanged: boolean }>("station/amendJobHistory", {
      stationId: stationB, jobId, from: new Date(Date.now() - 2 * 3_600_000).toISOString(), to: new Date(Date.now() - 3_600_000).toISOString(),
    }, roaming.legacyToken);
    expect(result.currentJobChanged).toBe(false);
    const row = await prisma.jobHistoryAmendment.findUniqueOrThrow({ where: { id: result.amendmentId } });
    expect(row).toMatchObject({ siteId, stationId: stationB, jobId, actorEmployeeId: null, actorUserId: null });
    expect(await prisma.stationJobLog.count({ where: { amendmentId: result.amendmentId, stationId: stationB, jobId } })).toBeGreaterThan(0);
  }, 30_000);

  it("the shared-plant alternate selector survives without opening catalog or stock writes", async () => {
    await request("product/setAltGroupActive", { altGroupId, productMaterialId: alternateMaterialId }, fixed.legacyToken);
    expect((await prisma.productMaterialAltGroup.findUniqueOrThrow({ where: { id: altGroupId } })).activeProductMaterialId).toBe(alternateMaterialId);
    await request("product/setAltGroupActive", { altGroupId, productMaterialId: outsiderMaterialId }, fixed.token, 403);
    await request("product/update", { id: productId, name: "Forbidden catalog change" }, fixed.token, 401);
    await request("inventory/adjustStock", { siteId, productId, mode: "delta", delta: 1, reason: "FOUND" }, fixed.token, 401);
  });

  it("station deletion returns 409 until displays are explicitly unassigned; the DB FK also restricts deletion", async () => {
    const station = await prisma.station.create({ data: { siteId, workcenterId: wcA, name: "Deletion protection" } });
    const display = await prisma.display.create({ data: { siteId, stationId: station.id, name: "Bound deletion fixture", status: "CLAIMED" } });
    displayIds.push(display.id);
    const rest = await server.inject({ method: "DELETE", url: `/stations/${station.id}`, headers: { authorization: `Bearer ${engineer.token}` } });
    expect(rest.statusCode, rest.body).toBe(409);
    await request("station/delete", { id: station.id }, engineer.token, 409);
    await expect(prisma.station.delete({ where: { id: station.id } })).rejects.toThrow(/Display_stationId_fkey/);
    expect((await prisma.display.findUniqueOrThrow({ where: { id: display.id } })).stationId).toBe(station.id);
    await request("display/update", { id: display.id, stationId: null }, engineer.token);
    await request("station/delete", { id: station.id }, engineer.token);
    expect((await prisma.display.findUniqueOrThrow({ where: { id: display.id } })).stationId).toBeNull();
  });
});

import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { call as callService } from "@rw/services/facility/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const FA_EMAIL = "calls-fa@test.local";
const READER_EMAIL = "calls-reader@test.local";
const OFFICE_EMAIL = "calls-office@test.local";
const PASSWORD = "calls-test-password-1";

type CallJson = {
  id: string;
  closedAt: string | null;
  openedByEmployeeId: string | null;
  closedByEmployeeId: string | null;
  deduped?: boolean;
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("calls", () => {
  let server: TestServer;
  let workspaceId: string;
  let siteA: { id: string };
  let siteB: { id: string };
  let stationA: { id: string };
  let stationA2: { id: string };
  let employeeId: string;
  let employeeVersionId: string;
  let officeEmployeeId: string;
  let roleOpsId: string;
  let roleMaintId: string;
  let roleSiteBId: string;
  let faToken: string;
  let readerToken: string;
  let officeToken: string;
  let dimIds: {
    stationId: string;
    wcId: string;
    jobId: string;
    toolId: string;
    productId: string;
    product2Id: string;
  } | null = null;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const rockware = await prisma.site.findFirstOrThrow({
      where: { name: "Rockware" },
      select: { id: true, workspaceId: true },
    });
    siteA = rockware;
    workspaceId = rockware.workspaceId;
    siteB = await prisma.site.upsert({
      where: { workspaceId_name: { workspaceId, name: "Calls Site B" } },
      update: {},
      create: { name: "Calls Site B", workspaceId },
      select: { id: true },
    });

    stationA = await prisma.station.upsert({
      where: { siteId_name: { siteId: siteA.id, name: "calls-test-station" } },
      update: {},
      create: { siteId: siteA.id, name: "calls-test-station" },
      select: { id: true },
    });
    stationA2 = await prisma.station.upsert({
      where: { siteId_name: { siteId: siteA.id, name: "calls-test-station-2" } },
      update: {},
      create: { siteId: siteA.id, name: "calls-test-station-2" },
      select: { id: true },
    });

    const faRole = await prisma.role.findUniqueOrThrow({
      where: { workspaceId_name_scope: { workspaceId, name: "Factory Administrator", scope: "SITE" } },
      select: { id: true },
    });
    const readerRole = await prisma.role.findUniqueOrThrow({
      where: { workspaceId_name_scope: { workspaceId, name: "Read-only User", scope: "SITE" } },
      select: { id: true },
    });
    const officeRole = await prisma.role.findUniqueOrThrow({
      where: { workspaceId_name_scope: { workspaceId, name: "Office User", scope: "SITE" } },
      select: { id: true },
    });
    const passwordHash = await hashPassword(PASSWORD);
    for (const { email, roleId } of [
      { email: FA_EMAIL, roleId: faRole.id },
      { email: READER_EMAIL, roleId: readerRole.id },
      { email: OFFICE_EMAIL, roleId: officeRole.id },
    ]) {
      const u = await prisma.user.upsert({
        where: { email },
        update: {},
        create: { email, passwordHash, firstName: "CallsTest", status: "ACTIVE" },
      });
      const membership = await prisma.workspaceMembership.upsert({
        where: { userId_workspaceId: { userId: u.id, workspaceId } },
        update: {},
        create: { userId: u.id, workspaceId },
      });
      const existing = await prisma.roleAssignment.findFirst({
        where: { membershipId: membership.id, roleId, siteId: siteA.id },
      });
      if (!existing) {
        await prisma.roleAssignment.create({ data: { membershipId: membership.id, roleId, siteId: siteA.id } });
      }
    }

    // Link the FA user's membership to an employee so USER-initiated calls
    // resolve attribution through WorkspaceMembership.employeeId.
    const employee = await prisma.employee.create({ data: { workspaceId }, select: { id: true } });
    employeeId = employee.id;
    const employeeVersion = await prisma.employeeVersion.create({
      data: { employeeId, version: 1, firstName: "Calls", lastName: "Tester" },
      select: { id: true },
    });
    employeeVersionId = employeeVersion.id;
    await prisma.employee.update({ where: { id: employeeId }, data: { versionId: employeeVersionId } });
    const faUser = await prisma.user.findUniqueOrThrow({ where: { email: FA_EMAIL }, select: { id: true } });
    await prisma.workspaceMembership.update({
      where: { userId_workspaceId: { userId: faUser.id, workspaceId } },
      data: { employeeId },
    });

    // Employee roles for the definition-level role gates: both employees hold
    // "ops" at siteA; "maint" has no members; the siteB role tests cross-site
    // rejection.
    const roleFor = async (siteId: string, name: string) =>
      (
        await prisma.employeeRole.upsert({
          where: { siteId_name: { siteId, name } },
          update: {},
          create: { siteId, name },
          select: { id: true },
        })
      ).id;
    roleOpsId = await roleFor(siteA.id, "calls-test-role-ops");
    roleMaintId = await roleFor(siteA.id, "calls-test-role-maint");
    roleSiteBId = await roleFor(siteB.id, "calls-test-role-b");
    await prisma.employeeSiteAccess.upsert({
      where: { employeeId_siteId: { employeeId, siteId: siteA.id } },
      update: { roleId: roleOpsId, status: "ACTIVE" },
      create: { employeeId, siteId: siteA.id, roleId: roleOpsId },
    });

    // The Office User gets its own employee (one membership per employee),
    // also in the ops role — calls:write without calls:admin, so no bypass.
    const officeEmployee = await prisma.employee.create({ data: { workspaceId }, select: { id: true } });
    officeEmployeeId = officeEmployee.id;
    await prisma.employeeSiteAccess.create({
      data: { employeeId: officeEmployeeId, siteId: siteA.id, roleId: roleOpsId },
    });
    const officeUser = await prisma.user.findUniqueOrThrow({ where: { email: OFFICE_EMAIL }, select: { id: true } });
    await prisma.workspaceMembership.update({
      where: { userId_workspaceId: { userId: officeUser.id, workspaceId } },
      data: { employeeId: officeEmployeeId },
    });

    faToken = (await loginAs(server, FA_EMAIL, PASSWORD)).accessToken;
    readerToken = (await loginAs(server, READER_EMAIL, PASSWORD)).accessToken;
    officeToken = (await loginAs(server, OFFICE_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.call.deleteMany({ where: { siteId: { in: [siteA.id, siteB.id] } } });
    await prisma.callDefinition.deleteMany({ where: { siteId: { in: [siteA.id, siteB.id] } } });
    if (dimIds) {
      await prisma.station.delete({ where: { id: dimIds.stationId } });
      await prisma.job.update({ where: { id: dimIds.jobId }, data: { currentVersionId: null } });
      await prisma.jobVersion.deleteMany({ where: { jobId: dimIds.jobId } });
      await prisma.jobProduct.updateMany({ where: { jobId: dimIds.jobId }, data: { currentVersionId: null } });
      await prisma.jobProductVersion.deleteMany({ where: { jobProduct: { jobId: dimIds.jobId } } });
      await prisma.job.delete({ where: { id: dimIds.jobId } });
      await prisma.tool.update({ where: { id: dimIds.toolId }, data: { currentVersionId: null } });
      await prisma.toolVersion.deleteMany({ where: { toolId: dimIds.toolId } });
      await prisma.tool.delete({ where: { id: dimIds.toolId } });
      await prisma.product.update({ where: { id: dimIds.productId }, data: { currentVersionId: null } });
      await prisma.productVersion.deleteMany({ where: { productId: dimIds.productId } });
      await prisma.product.delete({ where: { id: dimIds.productId } });
      await prisma.product.delete({ where: { id: dimIds.product2Id } });
      await prisma.workcenter.delete({ where: { id: dimIds.wcId } });
    }
    await prisma.workspaceMembership.updateMany({
      where: { employeeId: { in: [employeeId, officeEmployeeId] } },
      data: { employeeId: null },
    });
    await prisma.employee.deleteMany({ where: { id: { in: [employeeId, officeEmployeeId] } } });
    await prisma.employeeRole.deleteMany({ where: { id: { in: [roleOpsId, roleMaintId, roleSiteBId] } } });
    await prisma.user.deleteMany({ where: { email: { in: [FA_EMAIL, READER_EMAIL, OFFICE_EMAIL] } } });
    await prisma.station.deleteMany({ where: { id: { in: [stationA.id, stationA2.id] } } });
    await prisma.site.deleteMany({ where: { name: "Calls Site B" } });
    await server.close();
  });

  async function createDefinition(input: Record<string, unknown>) {
    const res = await rpcCall(server, "callDefinition/create", { siteId: siteA.id, ...input }, faToken);
    expect(res.statusCode).toBe(200);
    return res.json as { id: string };
  }

  it("definition CRUD: create, duplicate-name conflict, update, archive", async () => {
    const def = await createDefinition({ name: "calls-test-crud", severity: "ALERT" });

    const dup = await rpcCall(server, "callDefinition/create", { siteId: siteA.id, name: "calls-test-crud" }, faToken);
    expect(dup.statusCode).toBe(409);

    const update = await rpcCall(server, "callDefinition/update", { id: def.id, description: "updated" }, faToken);
    expect(update.statusCode).toBe(200);

    const archive = await rpcCall(server, "callDefinition/archive", { id: def.id }, faToken);
    expect(archive.statusCode).toBe(200);
    const get = await rpcCall(server, "callDefinition/get", { id: def.id }, faToken);
    expect(get.statusCode).toBe(404);

    // Names stay unique per site, archived rows included (archive/unarchive
    // name semantics deferred) — reuse conflicts cleanly instead of 500ing.
    const reuse = await rpcCall(server, "callDefinition/create", { siteId: siteA.id, name: "calls-test-crud" }, faToken);
    expect(reuse.statusCode).toBe(409);
  });

  it("permissions: reader cannot create definitions or open calls; cross-site writes denied", async () => {
    const create = await rpcCall(server, "callDefinition/create", { siteId: siteA.id, name: "calls-x" }, readerToken);
    expect(create.statusCode).toBe(403);

    const crossSite = await rpcCall(server, "callDefinition/create", { siteId: siteB.id, name: "calls-x" }, faToken);
    expect(crossSite.statusCode).toBe(403);

    const def = await createDefinition({ name: "calls-test-perms" });
    const open = await rpcCall(
      server,
      "call/open",
      { stationId: stationA.id, definitionId: def.id },
      readerToken,
    );
    expect(open.statusCode).toBe(403);
  });

  it("definition list is site-scoped with the standard pagination shape", async () => {
    await createDefinition({ name: "calls-test-list" });

    const res = await rpcCall(server, "callDefinition/list", { siteId: siteA.id }, faToken);
    expect(res.statusCode).toBe(200);
    const body = res.json as { data: Array<{ name: string }>; total: number; limit: number; offset: number };
    expect(body.data.map((d) => d.name)).toContain("calls-test-list");
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("open resolves the USER's employee via the membership link and dedupes re-opens", async () => {
    const def = await createDefinition({ name: "calls-test-open" });

    const first = await rpcCall(server, "call/open", { stationId: stationA.id, definitionId: def.id }, faToken);
    expect(first.statusCode).toBe(200);
    const opened = first.json as CallJson & { openedByEmployeeVersionId: string | null };
    expect(opened.openedByEmployeeId).toBe(employeeId);
    expect(opened.openedByEmployeeVersionId).toBe(employeeVersionId);
    expect(opened.deduped).toBe(false);
    expect(opened.closedAt).toBeNull();

    const second = await rpcCall(server, "call/open", { stationId: stationA.id, definitionId: def.id }, faToken);
    expect(second.statusCode).toBe(200);
    const deduped = second.json as CallJson;
    expect(deduped.id).toBe(opened.id);
    expect(deduped.deduped).toBe(true);

    // Same definition at a different station is an independent call.
    const other = await rpcCall(server, "call/open", { stationId: stationA2.id, definitionId: def.id }, faToken);
    expect(other.statusCode).toBe(200);
    expect((other.json as CallJson).id).not.toBe(opened.id);
  });

  it("concurrent opens race down to exactly one open call (partial unique index)", async () => {
    const def = await createDefinition({ name: "calls-test-race" });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        callService.open({ stationId: stationA.id, definitionId: def.id, source: "SYSTEM", sourceType: "test.race" }),
      ),
    );
    for (const result of results) {
      expect("error" in result).toBe(false);
    }
    const openRows = await prisma.call.count({
      where: { stationId: stationA.id, definitionId: def.id, closedAt: null },
    });
    expect(openRows).toBe(1);
  });

  it("requireOpenMessage forces a message on manual opens; SYSTEM opens are exempt", async () => {
    const def = await createDefinition({ name: "calls-test-req-msg", requireOpenMessage: true });

    const noMessage = await rpcCall(server, "call/open", { stationId: stationA.id, definitionId: def.id }, faToken);
    expect(noMessage.statusCode).toBe(400);

    const blankMessage = await rpcCall(
      server,
      "call/open",
      { stationId: stationA.id, definitionId: def.id, message: "   " },
      faToken,
    );
    expect(blankMessage.statusCode).toBe(400);

    const withMessage = await rpcCall(
      server,
      "call/open",
      { stationId: stationA.id, definitionId: def.id, message: "leak at nozzle" },
      faToken,
    );
    expect(withMessage.statusCode).toBe(200);
    await rpcCall(server, "call/close", { id: (withMessage.json as CallJson).id }, faToken);

    const systemOpen = await callService.open({
      stationId: stationA.id,
      definitionId: def.id,
      source: "SYSTEM",
      sourceType: "test.exempt",
    });
    expect("error" in systemOpen).toBe(false);
  });

  it("programmatic open records SYSTEM source and origin context", async () => {
    const def = await createDefinition({ name: "calls-test-system" });
    const opened = await callService.open({
      stationId: stationA.id,
      definitionId: def.id,
      source: "SYSTEM",
      sourceType: "station.down",
      sourceRef: "test-ref",
    });
    if ("error" in opened) throw new Error(opened.error);
    expect(opened.data.source).toBe("SYSTEM");
    expect(opened.data.sourceType).toBe("station.down");
    expect(opened.data.sourceRef).toBe("test-ref");
  });

  it("open snapshots BI dimensions: workcenter, job, job version, tool, product, shift", async () => {
    const wc = await prisma.workcenter.create({
      data: { siteId: siteA.id, name: "calls-test-wc" },
      select: { id: true },
    });
    const station = await prisma.station.create({
      data: { siteId: siteA.id, name: "calls-test-dim-station", workcenterId: wc.id },
      select: { id: true },
    });
    const tool = await prisma.tool.create({ data: { siteId: siteA.id }, select: { id: true } });
    const toolVersion = await prisma.toolVersion.create({
      data: { toolId: tool.id, version: 1, name: "calls-test-tv" },
      select: { id: true },
    });
    await prisma.tool.update({ where: { id: tool.id }, data: { currentVersionId: toolVersion.id } });
    const product = await prisma.product.create({ data: { siteId: siteA.id }, select: { id: true } });
    const productVersion = await prisma.productVersion.create({
      data: { productId: product.id, version: 1, sku: "calls-test-sku" },
      select: { id: true },
    });
    await prisma.product.update({ where: { id: product.id }, data: { currentVersionId: productVersion.id } });
    const job = await prisma.job.create({ data: { siteId: siteA.id }, select: { id: true } });
    const jobVersion = await prisma.jobVersion.create({
      data: { jobId: job.id, version: 1, name: "calls-test-jv" },
      select: { id: true },
    });
    await prisma.job.update({ where: { id: job.id }, data: { currentVersionId: jobVersion.id } });
    await prisma.jobTool.create({ data: { jobId: job.id, toolId: tool.id } });
    const jobProduct = await prisma.jobProduct.create({
      data: { jobId: job.id, productId: product.id },
      select: { id: true },
    });
    const jobProductVersion = await prisma.jobProductVersion.create({
      data: { jobProductId: jobProduct.id, version: 1 },
      select: { id: true },
    });
    await prisma.jobProduct.update({ where: { id: jobProduct.id }, data: { currentVersionId: jobProductVersion.id } });
    // A deactivated second product must not break single-product stamping.
    const product2 = await prisma.product.create({ data: { siteId: siteA.id }, select: { id: true } });
    const jobProduct2 = await prisma.jobProduct.create({
      data: { jobId: job.id, productId: product2.id },
      select: { id: true },
    });
    const jp2Version = await prisma.jobProductVersion.create({
      data: { jobProductId: jobProduct2.id, version: 1, isActive: false },
      select: { id: true },
    });
    await prisma.jobProduct.update({ where: { id: jobProduct2.id }, data: { currentVersionId: jp2Version.id } });
    await prisma.station.update({ where: { id: station.id }, data: { currentJobId: job.id } });
    dimIds = {
      stationId: station.id,
      wcId: wc.id,
      jobId: job.id,
      toolId: tool.id,
      productId: product.id,
      product2Id: product2.id,
    };

    const def = await createDefinition({ name: "calls-test-dims" });
    const res = await rpcCall(server, "call/open", { stationId: station.id, definitionId: def.id }, faToken);
    expect(res.statusCode).toBe(200);
    const opened = res.json as Record<string, unknown>;
    expect(opened.workcenterId).toBe(wc.id);
    expect(opened.jobId).toBe(job.id);
    expect(opened.jobVersionId).toBe(jobVersion.id);
    expect(opened.toolId).toBe(tool.id);
    expect(opened.toolVersionId).toBe(toolVersion.id);
    expect(opened.productId).toBe(product.id);
    expect(opened.productVersionId).toBe(productVersion.id);

    // And listActive can dimension by the snapshot workcenter directly.
    const active = await rpcCall(server, "call/listActive", { workcenterId: wc.id }, faToken);
    expect((active.json as { data: Array<{ id: string }> }).data.map((c) => c.id)).toContain(opened.id);
  });

  it("close records the closer, is idempotent-hostile (second close conflicts), and history remains", async () => {
    const def = await createDefinition({ name: "calls-test-close" });
    const open = await rpcCall(server, "call/open", { stationId: stationA.id, definitionId: def.id }, faToken);
    const opened = open.json as CallJson;

    const close = await rpcCall(server, "call/close", { id: opened.id, closeMessage: "handled" }, faToken);
    expect(close.statusCode).toBe(200);
    const closed = close.json as CallJson & { closedByEmployeeVersionId: string | null };
    expect(closed.closedAt).not.toBeNull();
    expect(closed.closedByEmployeeId).toBe(employeeId);
    expect(closed.closedByEmployeeVersionId).toBe(employeeVersionId);

    const again = await rpcCall(server, "call/close", { id: opened.id }, faToken);
    expect(again.statusCode).toBe(409);

    const active = await rpcCall(server, "call/listActive", { stationId: stationA.id, definitionId: def.id }, faToken);
    expect((active.json as { total: number }).total).toBe(0);

    const history = await rpcCall(
      server,
      "call/search",
      { siteId: siteA.id, definitionId: def.id, status: "closed" },
      faToken,
    );
    expect(history.statusCode).toBe(200);
    const found = (history.json as { data: CallJson[] }).data;
    expect(found.map((c) => c.id)).toContain(opened.id);
  });

  it("listActive filters by station and severity and pages with the standard shape", async () => {
    const def = await createDefinition({ name: "calls-test-active", severity: "WARNING" });
    const open = await rpcCall(server, "call/open", { stationId: stationA2.id, definitionId: def.id }, faToken);
    expect(open.statusCode).toBe(200);

    const res = await rpcCall(
      server,
      "call/listActive",
      { stationId: stationA2.id, severity: "WARNING", limit: 10, offset: 0 },
      faToken,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json as { data: CallJson[]; total: number; limit: number; offset: number };
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.data.map((c) => c.id)).toContain((open.json as CallJson).id);

    const other = await rpcCall(server, "call/listActive", { stationId: stationA2.id, severity: "ALERT" }, faToken);
    expect((other.json as { data: CallJson[] }).data.map((c) => c.id)).not.toContain((open.json as CallJson).id);
  });

  type DefRolesJson = {
    id: string;
    openRoles: Array<{ id: string; name: string }>;
    answerRoles: Array<{ id: string; name: string }>;
  };

  it("definition role lists round-trip and reject roles from another site", async () => {
    const created = await rpcCall(
      server,
      "callDefinition/create",
      {
        siteId: siteA.id,
        name: "calls-test-roles-crud",
        openRoleIds: [roleMaintId],
        answerRoleIds: [roleMaintId, roleOpsId],
      },
      faToken,
    );
    expect(created.statusCode).toBe(200);
    const def = created.json as DefRolesJson;
    expect(def.openRoles.map((r) => r.id)).toEqual([roleMaintId]);
    expect(def.answerRoles.map((r) => r.id).sort()).toEqual([roleMaintId, roleOpsId].sort());

    // Whole-list replacement: [] clears the restriction back to "everyone".
    const cleared = await rpcCall(server, "callDefinition/update", { id: def.id, openRoleIds: [] }, faToken);
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json as DefRolesJson).openRoles).toEqual([]);

    const crossSite = await rpcCall(server, "callDefinition/update", { id: def.id, answerRoleIds: [roleSiteBId] }, faToken);
    expect(crossSite.statusCode).toBe(404);
  });

  it("openRoles gates manual opens by the actor's site role; SYSTEM opens bypass", async () => {
    const def = await createDefinition({ name: "calls-test-open-gate", openRoleIds: [roleMaintId] });

    // Both test employees hold the ops role, so manual opens are denied —
    // calls:admin does NOT bypass the open gate.
    const denied = await rpcCall(server, "call/open", { stationId: stationA.id, definitionId: def.id }, officeToken);
    expect(denied.statusCode).toBe(403);
    const deniedFa = await rpcCall(server, "call/open", { stationId: stationA.id, definitionId: def.id }, faToken);
    expect(deniedFa.statusCode).toBe(403);

    const systemOpen = await callService.open({
      stationId: stationA.id,
      definitionId: def.id,
      source: "SYSTEM",
      sourceType: "test.role-gate",
    });
    expect("error" in systemOpen).toBe(false);

    const opsDef = await createDefinition({ name: "calls-test-open-gate-ops", openRoleIds: [roleOpsId] });
    const allowed = await rpcCall(server, "call/open", { stationId: stationA2.id, definitionId: opsDef.id }, officeToken);
    expect(allowed.statusCode).toBe(200);
  });

  it("answerRoles gates closing; calls:admin bypasses; unattributed actors are denied", async () => {
    const def = await createDefinition({ name: "calls-test-answer-gate", answerRoleIds: [roleMaintId] });

    const open = await rpcCall(server, "call/open", { stationId: stationA.id, definitionId: def.id }, officeToken);
    expect(open.statusCode).toBe(200);
    const callId = (open.json as CallJson).id;

    // Office user holds the ops role, not maint → denied.
    const denied = await rpcCall(server, "call/close", { id: callId }, officeToken);
    expect(denied.statusCode).toBe(403);

    // No resolvable employee at all is denied the same way.
    const unattributed = await callService.close({ id: callId });
    expect("error" in unattributed && unattributed.code).toBe("ANSWER_ROLE_RESTRICTED");

    // FA also holds only the ops role, but calls:admin bypasses the gate.
    const bypass = await rpcCall(server, "call/close", { id: callId }, faToken);
    expect(bypass.statusCode).toBe(200);
  });
});

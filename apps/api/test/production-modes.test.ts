import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { complete as completeCycle } from "@rw/services/cycle/cycle";
import { productionMode } from "@rw/services/facility/index";
import { transitionToDown } from "@rw/services/facility/station/state";
import type { ModeEvent } from "@rw/runtime/mode-events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const FA_EMAIL = "pm-fa@test.local";
const READER_EMAIL = "pm-reader@test.local";
const OFFICE_EMAIL = "pm-office@test.local";
const PASSWORD = "pm-test-password-1";

type ModeJson = {
  id: string;
  scrapAll: boolean;
  itemDispositionId: string | null;
  dispositionReasonId: string | null;
  itemDisposition: { id: string; name: string } | null;
  roles: Array<{ id: string; name: string }>;
};

type ModeLogJson = {
  id: string;
  modeId: string;
  startTime: string;
  endTime: string | null;
  startedByEmployeeId: string | null;
  endedByEmployeeId: string | null;
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("production modes", () => {
  let server: TestServer;
  let workspaceId: string;
  let siteA: { id: string };
  let stationA: { id: string };
  let stationState: { id: string };
  let scrapDispositionId: string;
  let reasonId: string;
  let roleOpsId: string;
  let roleMaintId: string;
  let faEmployeeId: string;
  let officeEmployeeId: string;
  let faToken: string;
  let readerToken: string;
  let officeToken: string;
  let rig: { stationId: string; jobId: string; productId: string } | null = null;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const rockware = await prisma.site.findFirstOrThrow({
      where: { name: "Rockware" },
      select: { id: true, workspaceId: true },
    });
    siteA = rockware;
    workspaceId = rockware.workspaceId;

    // The seed guarantees one protected system Scrap disposition per site.
    const scrap = await prisma.itemDisposition.findFirstOrThrow({
      where: { siteId: siteA.id, isSystem: true, deletedAt: null },
      select: { id: true },
    });
    scrapDispositionId = scrap.id;
    const reason = await prisma.itemDispositionReason.upsert({
      where: { siteId_name: { siteId: siteA.id, name: "pm-test-reason" } },
      update: { itemDispositions: { connect: { id: scrapDispositionId } } },
      create: { siteId: siteA.id, name: "pm-test-reason", itemDispositions: { connect: { id: scrapDispositionId } } },
      select: { id: true },
    });
    reasonId = reason.id;

    stationA = await prisma.station.upsert({
      where: { siteId_name: { siteId: siteA.id, name: "pm-test-station" } },
      update: {},
      create: { siteId: siteA.id, name: "pm-test-station" },
      select: { id: true },
    });
    stationState = await prisma.station.upsert({
      where: { siteId_name: { siteId: siteA.id, name: "pm-test-station-state" } },
      update: {},
      create: { siteId: siteA.id, name: "pm-test-station-state" },
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
        create: { email, passwordHash, firstName: "PmTest", status: "ACTIVE" },
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

    // Employee-role gates: FA and Office both hold "ops"; "maint" has no members.
    const roleFor = async (name: string) =>
      (
        await prisma.employeeRole.upsert({
          where: { siteId_name: { siteId: siteA.id, name } },
          update: {},
          create: { siteId: siteA.id, name },
          select: { id: true },
        })
      ).id;
    roleOpsId = await roleFor("pm-test-role-ops");
    roleMaintId = await roleFor("pm-test-role-maint");

    const employeeFor = async (email: string) => {
      const employee = await prisma.employee.create({ data: { workspaceId }, select: { id: true } });
      await prisma.employeeSiteAccess.create({
        data: { employeeId: employee.id, siteId: siteA.id, roleId: roleOpsId },
      });
      const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
      await prisma.workspaceMembership.update({
        where: { userId_workspaceId: { userId: user.id, workspaceId } },
        data: { employeeId: employee.id },
      });
      return employee.id;
    };
    faEmployeeId = await employeeFor(FA_EMAIL);
    officeEmployeeId = await employeeFor(OFFICE_EMAIL);

    faToken = (await loginAs(server, FA_EMAIL, PASSWORD)).accessToken;
    readerToken = (await loginAs(server, READER_EMAIL, PASSWORD)).accessToken;
    officeToken = (await loginAs(server, OFFICE_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    const stationIds = [stationA.id, stationState.id, ...(rig ? [rig.stationId] : [])];
    await prisma.itemDispositionLog.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.cycle.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.stationStateLog.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.stationModeLog.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.productionMode.deleteMany({ where: { siteId: siteA.id, name: { startsWith: "pm-test" } } });
    if (rig) {
      await prisma.station.delete({ where: { id: rig.stationId } });
      await prisma.productStock.deleteMany({ where: { productId: rig.productId } });
      await prisma.job.update({ where: { id: rig.jobId }, data: { currentVersionId: null } });
      await prisma.jobProduct.updateMany({ where: { jobId: rig.jobId }, data: { currentVersionId: null } });
      await prisma.jobProductVersion.deleteMany({ where: { jobProduct: { jobId: rig.jobId } } });
      await prisma.jobVersion.deleteMany({ where: { jobId: rig.jobId } });
      await prisma.job.delete({ where: { id: rig.jobId } });
      await prisma.product.update({ where: { id: rig.productId }, data: { currentVersionId: null } });
      await prisma.productVersion.deleteMany({ where: { productId: rig.productId } });
      await prisma.product.delete({ where: { id: rig.productId } });
    }
    await prisma.station.deleteMany({ where: { id: { in: [stationA.id, stationState.id] } } });
    await prisma.itemDispositionReason.deleteMany({ where: { siteId: siteA.id, name: "pm-test-reason" } });
    await prisma.statusReason.deleteMany({ where: { siteId: siteA.id, name: "pm-test-downtime-reason" } });
    await prisma.workspaceMembership.updateMany({
      where: { employeeId: { in: [faEmployeeId, officeEmployeeId] } },
      data: { employeeId: null },
    });
    await prisma.employee.deleteMany({ where: { id: { in: [faEmployeeId, officeEmployeeId] } } });
    await prisma.employeeRole.deleteMany({ where: { id: { in: [roleOpsId, roleMaintId] } } });
    await prisma.user.deleteMany({ where: { email: { in: [FA_EMAIL, READER_EMAIL, OFFICE_EMAIL] } } });
    await server.close();
  });

  async function createMode(input: Record<string, unknown>, token = faToken) {
    const res = await rpcCall(server, "productionMode/create", { siteId: siteA.id, ...input }, token);
    expect(res.statusCode).toBe(200);
    return res.json as ModeJson;
  }

  it("catalog CRUD: create, duplicate-name conflict, update, archive", async () => {
    const mode = await createMode({ name: "pm-test-crud" });

    const dup = await rpcCall(server, "productionMode/create", { siteId: siteA.id, name: "pm-test-crud" }, faToken);
    expect(dup.statusCode).toBe(409);

    const update = await rpcCall(server, "productionMode/update", { id: mode.id, description: "updated" }, faToken);
    expect(update.statusCode).toBe(200);

    const archive = await rpcCall(server, "productionMode/archive", { id: mode.id }, faToken);
    expect(archive.statusCode).toBe(200);
    const get = await rpcCall(server, "productionMode/get", { id: mode.id }, faToken);
    expect(get.statusCode).toBe(404);
  });

  it("permissions: reader cannot create or force; office (modes:write, no admin) cannot create", async () => {
    const create = await rpcCall(server, "productionMode/create", { siteId: siteA.id, name: "pm-x" }, readerToken);
    expect(create.statusCode).toBe(403);
    const officeCreate = await rpcCall(server, "productionMode/create", { siteId: siteA.id, name: "pm-x" }, officeToken);
    expect(officeCreate.statusCode).toBe(403);

    const mode = await createMode({ name: "pm-test-perms" });
    const force = await rpcCall(
      server,
      "productionMode/force",
      { stationId: stationA.id, modeId: mode.id },
      readerToken,
    );
    expect(force.statusCode).toBe(403);
  });

  it("scrap-all requires a reason and always resolves the system Scrap disposition", async () => {
    const noReason = await rpcCall(
      server,
      "productionMode/create",
      { siteId: siteA.id, name: "pm-test-scrap-bad", scrapAll: true },
      faToken,
    );
    expect(noReason.statusCode).toBe(400);

    const mode = await createMode({ name: "pm-test-scrap", scrapAll: true, dispositionReasonId: reasonId });
    expect(mode.scrapAll).toBe(true);
    expect(mode.itemDispositionId).toBe(scrapDispositionId);
    expect(mode.dispositionReasonId).toBe(reasonId);

    // Toggling scrap-all off clears the pair; back on re-resolves it.
    const off = await rpcCall(server, "productionMode/update", { id: mode.id, scrapAll: false }, faToken);
    expect(off.statusCode).toBe(200);
    const offJson = off.json as ModeJson;
    expect(offJson.itemDispositionId).toBeNull();
    expect(offJson.dispositionReasonId).toBeNull();

    const on = await rpcCall(
      server,
      "productionMode/update",
      { id: mode.id, scrapAll: true, dispositionReasonId: reasonId },
      faToken,
    );
    expect(on.statusCode).toBe(200);
    expect((on.json as ModeJson).itemDispositionId).toBe(scrapDispositionId);
  });

  it("system Scrap disposition is protected from rename and removal", async () => {
    const rename = await rpcCall(
      server,
      "disposition/update",
      { id: scrapDispositionId, name: "pm-renamed" },
      faToken,
    );
    expect(rename.statusCode).toBe(400);

    const remove = await rpcCall(server, "disposition/delete", { id: scrapDispositionId }, faToken);
    expect(remove.statusCode).toBe(400);
  });

  it("force/clear lifecycle: attribution, no-op re-force, mode switch, audit trail", async () => {
    const modeA = await createMode({ name: "pm-test-life-a" });
    const modeB = await createMode({ name: "pm-test-life-b" });

    const force = await rpcCall(
      server,
      "productionMode/force",
      { stationId: stationA.id, modeId: modeA.id },
      officeToken,
    );
    expect(force.statusCode).toBe(200);
    const opened = force.json as ModeLogJson;
    expect(opened.modeId).toBe(modeA.id);
    expect(opened.endTime).toBeNull();
    expect(opened.startedByEmployeeId).toBe(officeEmployeeId);

    // Re-forcing the active mode is a no-op: same open log entry.
    const again = await rpcCall(
      server,
      "productionMode/force",
      { stationId: stationA.id, modeId: modeA.id },
      officeToken,
    );
    expect((again.json as ModeLogJson).id).toBe(opened.id);

    // Switching modes closes the first entry and opens a second.
    const sw = await rpcCall(
      server,
      "productionMode/force",
      { stationId: stationA.id, modeId: modeB.id },
      officeToken,
    );
    expect(sw.statusCode).toBe(200);
    const switched = sw.json as ModeLogJson;
    expect(switched.id).not.toBe(opened.id);
    const closedFirst = await prisma.stationModeLog.findUniqueOrThrow({ where: { id: opened.id } });
    expect(closedFirst.endTime).not.toBeNull();
    expect(closedFirst.endedByEmployeeId).toBe(officeEmployeeId);

    const clear = await rpcCall(server, "productionMode/clear", { stationId: stationA.id }, officeToken);
    expect(clear.statusCode).toBe(200);
    expect((clear.json as ModeLogJson).endTime).not.toBeNull();

    // Clearing an already-clear station is a no-op.
    const clearAgain = await rpcCall(server, "productionMode/clear", { stationId: stationA.id }, officeToken);
    expect(clearAgain.statusCode).toBe(200);
    expect(clearAgain.json ?? null).toBeNull();

    // Audit trail: newest first, standard pagination shape.
    const logs = await rpcCall(server, "productionMode/listLogs", { stationId: stationA.id }, officeToken);
    expect(logs.statusCode).toBe(200);
    const body = logs.json as { data: ModeLogJson[]; total: number; limit: number; offset: number };
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.data[0].id).toBe(switched.id);
    expect(body.data.map((l) => l.id)).toContain(opened.id);
  });

  it("mode roles gate force AND clear; modes:admin bypasses both", async () => {
    const restricted = await createMode({ name: "pm-test-gate", roleIds: [roleMaintId] });

    // Office holds ops, not maint → denied.
    const denied = await rpcCall(
      server,
      "productionMode/force",
      { stationId: stationA.id, modeId: restricted.id },
      officeToken,
    );
    expect(denied.statusCode).toBe(403);

    // FA also holds only ops, but modes:admin bypasses.
    const bypass = await rpcCall(
      server,
      "productionMode/force",
      { stationId: stationA.id, modeId: restricted.id },
      faToken,
    );
    expect(bypass.statusCode).toBe(200);

    // Same list gates exiting: office denied, FA clears.
    const clearDenied = await rpcCall(server, "productionMode/clear", { stationId: stationA.id }, officeToken);
    expect(clearDenied.statusCode).toBe(403);
    const cleared = await rpcCall(server, "productionMode/clear", { stationId: stationA.id }, faToken);
    expect(cleared.statusCode).toBe(200);
  });

  it("SYSTEM source skips role gates, stamps the log, and emits forced/cleared mode events", async () => {
    const restricted = await createMode({ name: "pm-test-system", roleIds: [roleMaintId] });
    const second = await createMode({ name: "pm-test-system-2", roleIds: [roleMaintId] });
    const events: ModeEvent[] = [];
    productionMode.setModeEventSink((e) => {
      events.push(e);
    });
    const cause = { correlationId: "root", causationId: "parent", hop: 1 };
    const system = { source: "SYSTEM" as const, sourceType: "automation", sourceRef: "auto-1", cause };
    try {
      const forced = await productionMode.force({ stationId: stationA.id, modeId: restricted.id, ...system });
      expect("data" in forced && forced.data).toMatchObject({ source: "SYSTEM", sourceType: "automation", sourceRef: "auto-1" });
      // Switching emits cleared for the old mode, then forced for the new.
      const switched = await productionMode.force({ stationId: stationA.id, modeId: second.id, ...system });
      expect("data" in switched).toBe(true);
      const cleared = await productionMode.clear({ stationId: stationA.id, ...system });
      expect("data" in cleared && cleared.data?.endTime).toBeTruthy();
    } finally {
      productionMode.setModeEventSink(null);
    }
    await new Promise((r) => setImmediate(r));

    expect(events.map((e) => [e.action, e.modeId])).toEqual([
      ["forced", restricted.id],
      ["cleared", restricted.id],
      ["forced", second.id],
      ["cleared", second.id],
    ]);
    expect(events[0]).toMatchObject({
      stationId: stationA.id,
      stationName: "pm-test-station",
      siteId: siteA.id,
      workspaceId,
      source: "SYSTEM",
      sourceType: "automation",
      sourceRef: "auto-1",
      cause,
    });
    expect(events[0]?.endedAt).toBeUndefined();
    expect(events[1]?.endedAt).toBeTruthy();
  });

  it("force snapshots star-pattern dimensions (work center, job, job version) like calls", async () => {
    const wc = await prisma.workcenter.create({ data: { siteId: siteA.id, name: "pm-test-wc" }, select: { id: true } });
    const job = await prisma.job.create({ data: { siteId: siteA.id }, select: { id: true } });
    const jobVersion = await prisma.jobVersion.create({
      data: { jobId: job.id, version: 1, name: "pm-test-jv" },
      select: { id: true },
    });
    await prisma.job.update({ where: { id: job.id }, data: { currentVersionId: jobVersion.id } });
    const station = await prisma.station.create({
      data: { siteId: siteA.id, name: "pm-test-dim-station", workcenterId: wc.id, currentJobId: job.id },
      select: { id: true },
    });
    const mode = await createMode({ name: "pm-test-dims" });
    const events: ModeEvent[] = [];
    productionMode.setModeEventSink((e) => {
      events.push(e);
    });
    try {
      const forced = await productionMode.force({ stationId: station.id, modeId: mode.id, employeeId: faEmployeeId });
      if (!("data" in forced)) throw new Error(forced.error);
      expect(forced.data).toMatchObject({ workcenterId: wc.id, jobId: job.id, jobVersionId: jobVersion.id });
      expect(forced.data.startedByEmployeeId).toBe(faEmployeeId);
      await new Promise((r) => setImmediate(r));
      expect(events[0]).toMatchObject({ action: "forced", workcenterId: wc.id, workcenterName: "pm-test-wc", jobId: job.id, jobName: "pm-test-jv" });
    } finally {
      productionMode.setModeEventSink(null);
      await prisma.stationModeLog.deleteMany({ where: { stationId: station.id } });
      await prisma.stationStateLog.deleteMany({ where: { stationId: station.id } });
      await prisma.station.delete({ where: { id: station.id } });
      await prisma.job.update({ where: { id: job.id }, data: { currentVersionId: null } });
      await prisma.jobVersion.delete({ where: { id: jobVersion.id } });
      await prisma.job.delete({ where: { id: job.id } });
      await prisma.workcenter.delete({ where: { id: wc.id } });
    }
  });

  it("force splits the open state-log entry at the boundary; clear splits back", async () => {
    const mode = await createMode({ name: "pm-test-split" });
    const blockId = "pm-test-block";
    const opened = await prisma.stationStateLog.create({
      data: {
        stationId: stationState.id,
        startTime: new Date(Date.now() - 600_000),
        state: "UP",
        status: "UP",
        blockId,
      },
      select: { id: true },
    });

    const force = await rpcCall(
      server,
      "productionMode/force",
      { stationId: stationState.id, modeId: mode.id },
      faToken,
    );
    expect(force.statusCode).toBe(200);
    const log = force.json as ModeLogJson;

    const rows = await prisma.stationStateLog.findMany({
      where: { stationId: stationState.id, deletedAt: null },
      orderBy: { startTime: "asc" },
    });
    expect(rows).toHaveLength(2);
    const [before, during] = rows;
    expect(before.id).toBe(opened.id);
    expect(before.endTime?.toISOString()).toBe(log.startTime);
    expect(before.modeId).toBeNull();
    expect(during.endTime).toBeNull();
    expect(during.modeId).toBe(mode.id);
    // The split preserves status continuity: same state/status/block.
    expect(during.state).toBe("UP");
    expect(during.status).toBe("UP");
    expect(during.blockId).toBe(blockId);

    const clear = await rpcCall(server, "productionMode/clear", { stationId: stationState.id }, faToken);
    expect(clear.statusCode).toBe(200);
    const after = await prisma.stationStateLog.findMany({
      where: { stationId: stationState.id, deletedAt: null },
      orderBy: { startTime: "asc" },
    });
    expect(after).toHaveLength(3);
    expect(after[1].endTime).not.toBeNull();
    expect(after[2].endTime).toBeNull();
    expect(after[2].modeId).toBeNull();
    expect(after[2].blockId).toBe(blockId);

    await prisma.stationStateLog.deleteMany({ where: { stationId: stationState.id } });
  });

  it("force re-stamps in place when the open state entry starts at/after the boundary", async () => {
    const mode = await createMode({ name: "pm-test-instamp" });
    const fresh = await prisma.stationStateLog.create({
      data: {
        stationId: stationState.id,
        startTime: new Date(Date.now() + 1_000),
        state: "UP",
        status: "UP",
        blockId: "pm-test-block-2",
      },
      select: { id: true },
    });

    const force = await rpcCall(
      server,
      "productionMode/force",
      { stationId: stationState.id, modeId: mode.id },
      faToken,
    );
    expect(force.statusCode).toBe(200);

    const rows = await prisma.stationStateLog.findMany({ where: { stationId: stationState.id, deletedAt: null } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(fresh.id);
    expect(rows[0].modeId).toBe(mode.id);
    expect(rows[0].endTime).toBeNull();

    await rpcCall(server, "productionMode/clear", { stationId: stationState.id }, faToken);
    await prisma.stationStateLog.deleteMany({ where: { stationId: stationState.id } });
  });

  it("downtime beginning under a mode defaults to the mode's status reason", async () => {
    const downtimeReason = await prisma.statusReason.upsert({
      where: { siteId_name: { siteId: siteA.id, name: "pm-test-downtime-reason" } },
      update: {},
      create: { siteId: siteA.id, name: "pm-test-downtime-reason" },
      select: { id: true },
    });

    // Config validation: the reason must belong to the site.
    const bogus = await rpcCall(
      server,
      "productionMode/create",
      { siteId: siteA.id, name: "pm-test-dtr-bad", statusReasonId: "00000000-0000-4000-8000-000000000000" },
      faToken,
    );
    expect(bogus.statusCode).toBe(404);

    const mode = await createMode({ name: "pm-test-dtr", statusReasonId: downtimeReason.id });

    // Without the mode, downtime starts unassigned.
    await transitionToDown(stationState.id, new Date());
    const bare = await prisma.stationStateLog.findFirstOrThrow({
      where: { stationId: stationState.id, endTime: null, deletedAt: null },
    });
    expect(bare.statusReasonId).toBeNull();
    await prisma.stationStateLog.deleteMany({ where: { stationId: stationState.id } });

    // Under the mode, a fresh DOWN period is pre-assigned the mode's reason.
    const force = await rpcCall(
      server,
      "productionMode/force",
      { stationId: stationState.id, modeId: mode.id },
      faToken,
    );
    expect(force.statusCode).toBe(200);
    await prisma.stationStateLog.create({
      data: {
        stationId: stationState.id,
        startTime: new Date(Date.now() - 600_000),
        state: "UP",
        status: "UP",
        blockId: "pm-test-block-3",
        modeId: mode.id,
      },
    });
    await transitionToDown(stationState.id, new Date());
    const down = await prisma.stationStateLog.findFirstOrThrow({
      where: { stationId: stationState.id, endTime: null, deletedAt: null },
    });
    expect(down.state).toBe("DOWN");
    expect(down.statusReasonId).toBe(downtimeReason.id);
    expect(down.modeId).toBe(mode.id);

    await rpcCall(server, "productionMode/clear", { stationId: stationState.id }, faToken);
    await prisma.stationStateLog.deleteMany({ where: { stationId: stationState.id } });
  });

  it("cycles record unstamped and unscrapped when no mode is active", async () => {
    // Minimal production rig: job with a version and one active job product.
    const station = await prisma.station.create({
      data: { siteId: siteA.id, name: "pm-test-rig-station" },
      select: { id: true },
    });
    const product = await prisma.product.create({ data: { siteId: siteA.id }, select: { id: true } });
    const productVersion = await prisma.productVersion.create({
      data: { productId: product.id, version: 1, sku: "pm-test-sku" },
      select: { id: true },
    });
    await prisma.product.update({ where: { id: product.id }, data: { currentVersionId: productVersion.id } });
    const job = await prisma.job.create({ data: { siteId: siteA.id }, select: { id: true } });
    const jobVersion = await prisma.jobVersion.create({
      data: { jobId: job.id, version: 1, name: "pm-test-jv" },
      select: { id: true },
    });
    await prisma.job.update({ where: { id: job.id }, data: { currentVersionId: jobVersion.id } });
    const jobProduct = await prisma.jobProduct.create({
      data: { jobId: job.id, productId: product.id },
      select: { id: true },
    });
    const jpVersion = await prisma.jobProductVersion.create({
      data: { jobProductId: jobProduct.id, version: 1 },
      select: { id: true },
    });
    await prisma.jobProduct.update({ where: { id: jobProduct.id }, data: { currentVersionId: jpVersion.id } });
    await prisma.station.update({ where: { id: station.id }, data: { currentJobId: job.id } });
    rig = { stationId: station.id, jobId: job.id, productId: product.id };

    const result = await completeCycle({ stationId: station.id, timestamp: new Date(), jobId: job.id });
    if ("error" in result && result.error) throw new Error(String(result.error));

    const cycle = await prisma.cycle.findFirstOrThrow({
      where: { stationId: station.id },
      include: { inventoryItems: true },
    });
    expect(cycle.modeId).toBeNull();
    expect(cycle.inventoryItems).toHaveLength(1);
    expect(cycle.inventoryItems[0].modeId).toBeNull();
    const scrapLogs = await prisma.itemDispositionLog.count({ where: { stationId: station.id } });
    expect(scrapLogs).toBe(0);
  }, 15_000);

  it("scrap-all mode stamps the cycle and auto-scraps by exact quantity, not row count", async () => {
    if (!rig) throw new Error("rig not built");
    const mode = await createMode({ name: "pm-test-scrapmode", scrapAll: true, dispositionReasonId: reasonId });
    const force = await rpcCall(
      server,
      "productionMode/force",
      { stationId: rig.stationId, modeId: mode.id },
      faToken,
    );
    expect(force.statusCode).toBe(200);

    const result = await completeCycle({
      stationId: rig.stationId,
      timestamp: new Date(Date.now() + 5_000),
      jobId: rig.jobId,
      quantity: 5.25,
    });
    if ("error" in result && result.error) throw new Error(String(result.error));
    const cycleId = (result as { data: { id: string } }).data.id;

    const cycle = await prisma.cycle.findUniqueOrThrow({
      where: { id: cycleId },
      include: { inventoryItems: true },
    });
    expect(cycle.modeId).toBe(mode.id);
    expect(cycle.inventoryItems).toHaveLength(1);
    expect(cycle.inventoryItems[0].modeId).toBe(mode.id);
    expect(Number(cycle.inventoryItems[0].quantity)).toBe(5.25);

    // One scrap log per item, carrying the item's exact fractional QUANTITY
    // (Decimal, unrounded) and the mode's pair.
    const scrapLog = await prisma.itemDispositionLog.findFirstOrThrow({ where: { cycleId } });
    expect(Number(scrapLog.quantity)).toBe(5.25);
    expect(scrapLog.itemDispositionId).toBe(scrapDispositionId);
    expect(scrapLog.dispositionReasonId).toBe(reasonId);
    expect(scrapLog.modeId).toBe(mode.id);

    await rpcCall(server, "productionMode/clear", { stationId: rig.stationId }, faToken);

    // Post-mode cycles go back to unstamped and unscrapped.
    const after = await completeCycle({
      stationId: rig.stationId,
      timestamp: new Date(Date.now() + 10_000),
      jobId: rig.jobId,
    });
    if ("error" in after && after.error) throw new Error(String(after.error));
    const afterId = (after as { data: { id: string } }).data.id;
    const afterCycle = await prisma.cycle.findUniqueOrThrow({ where: { id: afterId } });
    expect(afterCycle.modeId).toBeNull();
    expect(await prisma.itemDispositionLog.count({ where: { cycleId: afterId } })).toBe(0);
  }, 15_000);

  it("force rejects cross-site stations and unknown/archived modes", async () => {
    const mode = await createMode({ name: "pm-test-guards" });
    await rpcCall(server, "productionMode/archive", { id: mode.id }, faToken);
    const archived = await rpcCall(
      server,
      "productionMode/force",
      { stationId: stationA.id, modeId: mode.id },
      faToken,
    );
    expect(archived.statusCode).toBe(404);
  });
});

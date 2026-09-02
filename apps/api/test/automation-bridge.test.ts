import prisma from "@rw/db";
import { call, productionMode } from "@rw/services/facility/index";
import * as notification from "@rw/services/notification/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppAutomationFramework } from "../src/automations/index.js";
import { fromCallEvent } from "../src/automations/events/call-changed.js";
import { fromModeEvent } from "../src/automations/events/mode-changed.js";

// Tier 2: real DB framework. A mode event opens a call through an automation; the resulting call
// event notifies a group through another; the chain and the dedupe key survive a redelivery.

describe.skipIf(!process.env.TEST_DATABASE_URL)("automation bridge", () => {
  let siteId: string;
  let workspaceId: string;
  let stationId: string;
  let definitionId: string;
  let modeId: string;
  let groupId: string;
  let employeeId: string;
  const automationIds: string[] = [];
  let fw: Awaited<ReturnType<typeof createAppAutomationFramework>>;

  beforeAll(async () => {
    const site = await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true, workspaceId: true } });
    siteId = site.id;
    workspaceId = site.workspaceId;
    stationId = (await prisma.station.upsert({ where: { siteId_name: { siteId, name: "bridge-test-station" } }, update: {}, create: { siteId, name: "bridge-test-station" }, select: { id: true } })).id;
    definitionId = (await prisma.callDefinition.upsert({ where: { siteId_name: { siteId, name: "bridge-test-call" } }, update: {}, create: { siteId, name: "bridge-test-call", severity: "ALERT" }, select: { id: true } })).id;
    modeId = (await prisma.productionMode.upsert({ where: { siteId_name: { siteId, name: "bridge-test-mode" } }, update: {}, create: { siteId, name: "bridge-test-mode" }, select: { id: true } })).id;
    const employee = await prisma.employee.create({ data: { workspaceId }, select: { id: true } });
    employeeId = employee.id;
    const version = await prisma.employeeVersion.create({ data: { employeeId, version: 1, firstName: "Bridge", lastName: "Test", email: "bridge@test.local" }, select: { id: true } });
    await prisma.employee.update({ where: { id: employeeId }, data: { versionId: version.id } });
    groupId = (await prisma.notificationGroup.create({ data: { siteId, name: "bridge-test-group", members: { connect: { id: employeeId } } }, select: { id: true } })).id;

    fw = await createAppAutomationFramework();
    const seed = async (label: string, event: string, action: string, actions: Array<{ type: string; inputs: Record<string, unknown> }>) => {
      const a = await fw.store.upsert({
        id: fw.store.newId(),
        label,
        enabled: true,
        event,
        eventVersion: "1",
        partition: siteId,
        conditions: { combinator: "and", rules: [{ field: "event.payload.action", operator: "=", value: action }] },
        actions: actions.map((x) => ({ version: "1", ...x })),
      });
      automationIds.push(a.id);
      return a;
    };
    await seed("bridge: mode forced → open call", "mode.changed", "forced", [{ type: "openCall", inputs: { definitionId, message: "Mode {{event.payload.modeName}} forced" } }]);
    await seed("bridge: call opened → notify", "call.changed", "opened", [{ type: "notifyGroup", inputs: { groupId, subject: "Call {{event.payload.definitionName}}", body: "at {{event.payload.stationName}}" } }]);
    await seed("bridge: mode cleared → close call", "mode.changed", "cleared", [{ type: "closeCall", inputs: { definitionId, closeMessage: "mode cleared" } }]);
    fw.engine.reload();
    notification.setChannelAdapter("EMAIL", { async send() { return { ok: true, providerMessageId: "bridge-msg" }; } });
  }, 30_000);

  afterAll(async () => {
    await prisma.automationRun.deleteMany({ where: { matches: { some: { automationId: { in: automationIds } } } } });
    await prisma.automation.deleteMany({ where: { id: { in: automationIds } } });
    await prisma.notification.deleteMany({ where: { groupId } });
    await prisma.notificationGroup.deleteMany({ where: { id: groupId } });
    await prisma.employee.deleteMany({ where: { id: employeeId } });
    await prisma.call.deleteMany({ where: { stationId } });
    await prisma.stationModeLog.deleteMany({ where: { stationId } });
    await prisma.callDefinition.deleteMany({ where: { id: definitionId } });
    await prisma.productionMode.deleteMany({ where: { id: modeId } });
    await prisma.station.deleteMany({ where: { id: stationId } });
  });

  const modeEvent = (action: "forced" | "cleared", id: string) =>
    fromModeEvent({ id, action, logId: "l", modeId, modeName: "bridge-test-mode", workspaceId, siteId, stationId, stationName: "bridge-test-station", source: "MANUAL", startedAt: new Date().toISOString(), emittedAt: new Date().toISOString() });

  it("mode forced → automation opens a SYSTEM call attributed to the automation, with the chain started", async () => {
    const eventId = "aaaaaaaa-0000-4000-8000-000000000001";
    const r = await fw.fire("mode.changed", modeEvent("forced", eventId), { id: eventId });
    expect(r.matched).toEqual([automationIds[0]]);

    const open = await call.listActive({ stationId, definitionId });
    expect(open.data).toHaveLength(1);
    expect(open.data[0]).toMatchObject({ source: "SYSTEM", sourceType: "automation", sourceRef: automationIds[0], message: "Mode bridge-test-mode forced" });
    const run = await prisma.automationRun.findFirst({ where: { eventId } });
    expect(run).toMatchObject({ siteId, correlationId: eventId, hop: 0 });
  });

  it("call opened → automation notifies the group once, even when the event is redelivered", async () => {
    const [opened] = (await call.listActive({ stationId, definitionId })).data;
    if (!opened) throw new Error("no open call from the previous test");
    // The call event carries the cause the openCall action passed through (the mode.changed automation event).
    const cause = { correlationId: "aaaaaaaa-0000-4000-8000-000000000001", causationId: "aaaaaaaa-0000-4000-8000-000000000001", hop: 0 };
    const eventId = "aaaaaaaa-0000-4000-8000-000000000002";
    const payload = fromCallEvent({ id: eventId, action: "opened", callId: opened.id, definitionId, definitionName: "bridge-test-call", severity: "ALERT", workspaceId, siteId, stationId, stationName: "bridge-test-station", source: "SYSTEM", sourceType: "automation", sourceRef: automationIds[0], openedAt: new Date().toISOString(), emittedAt: new Date().toISOString(), cause });

    const first = await fw.fire("call.changed", payload, { id: eventId, cause });
    const again = await fw.fire("call.changed", payload, { id: eventId, cause });
    expect(first.matched).toEqual([automationIds[1]]);
    expect(again.matched).toEqual([automationIds[1]]);

    const sent = await prisma.notification.findMany({ where: { groupId }, include: { deliveries: true } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ subject: "Call bridge-test-call", body: "at bridge-test-station", source: "SYSTEM", sourceType: "automation", sourceRef: automationIds[1], dedupeKey: `${eventId}:${automationIds[1]}:0` });
    expect(sent[0]?.deliveries[0]).toMatchObject({ employeeId, status: "SENT", providerMessageId: "bridge-msg" });

    const runs = await prisma.automationRun.findMany({ where: { eventId }, orderBy: { firedAt: "asc" } });
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ correlationId: cause.correlationId, causationId: cause.causationId, hop: 1 });
  });

  it("mode cleared → automation closes the open call; a second clear finds nothing and still succeeds", async () => {
    const eventId = "aaaaaaaa-0000-4000-8000-000000000003";
    const r = await fw.fire("mode.changed", modeEvent("cleared", eventId), { id: eventId });
    expect(r.matched).toEqual([automationIds[2]]);
    expect((await call.listActive({ stationId, definitionId })).data).toHaveLength(0);
    const closed = await prisma.call.findFirst({ where: { stationId, definitionId }, select: { closeMessage: true, closedAt: true } });
    expect(closed).toMatchObject({ closeMessage: "mode cleared" });
    expect(closed?.closedAt).not.toBeNull();

    const r2 = await fw.fire("mode.changed", modeEvent("cleared", "aaaaaaaa-0000-4000-8000-000000000004"), { id: "aaaaaaaa-0000-4000-8000-000000000004" });
    expect(r2.matched).toEqual([automationIds[2]]);
    // productionMode is imported to keep the mode catalog row referenced; force/clear themselves are covered elsewhere.
    expect(productionMode).toBeTruthy();
  });
});

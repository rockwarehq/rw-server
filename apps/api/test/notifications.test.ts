import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import type { NotificationEvent } from "@rw/runtime/notification-events";
import * as notification from "@rw/services/notification/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const FA_EMAIL = "notif-fa@test.local";
const READER_EMAIL = "notif-reader@test.local";
const OFFICE_EMAIL = "notif-office@test.local";
const PASSWORD = "notif-test-password-1";

type GroupJson = { id: string; channels: string[]; members: Array<{ id: string }> };
type NotificationJson = {
  id: string;
  source: string;
  deliveries: Array<{ employeeId: string | null; channel: string; status: string; address: string | null; providerMessageId: string | null }>;
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("notifications", () => {
  let server: TestServer;
  let workspaceId: string;
  let siteA: { id: string };
  let withEmailId: string;
  let withoutEmailId: string;
  let faToken: string;
  let readerToken: string;
  let officeToken: string;
  const groupIds: string[] = [];

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const rockware = await prisma.site.findFirstOrThrow({
      where: { name: "Rockware" },
      select: { id: true, workspaceId: true },
    });
    siteA = rockware;
    workspaceId = rockware.workspaceId;

    const roleFor = (name: string) =>
      prisma.role.findUniqueOrThrow({ where: { workspaceId_name_scope: { workspaceId, name, scope: "SITE" } }, select: { id: true } });
    // Custom role: notifications:write without notifications:admin — Plant
    // Member has no writes; Plant Admin's admin would pass the group gates.
    const senderRole = await prisma.role.upsert({
      where: { workspaceId_name_scope: { workspaceId, name: "notif-test-sender", scope: "SITE" } },
      update: { permissions: ["facility:read", "notifications:read", "notifications:write"] },
      create: {
        workspaceId,
        name: "notif-test-sender",
        scope: "SITE",
        permissions: ["facility:read", "notifications:read", "notifications:write"],
      },
      select: { id: true },
    });
    const passwordHash = await hashPassword(PASSWORD);
    for (const { email, role } of [
      { email: FA_EMAIL, role: "Plant Admin" },
      { email: READER_EMAIL, role: "Plant Member" },
      { email: OFFICE_EMAIL, role: null },
    ]) {
      const { id: roleId } = role ? await roleFor(role) : senderRole;
      const u = await prisma.user.upsert({
        where: { email },
        update: {},
        create: { email, passwordHash, firstName: "NotifTest", status: "ACTIVE" },
      });
      const membership = await prisma.workspaceMembership.upsert({
        where: { userId_workspaceId: { userId: u.id, workspaceId } },
        update: {},
        create: { userId: u.id, workspaceId },
      });
      const existing = await prisma.roleAssignment.findFirst({ where: { membershipId: membership.id, roleId, siteId: siteA.id } });
      if (!existing) await prisma.roleAssignment.create({ data: { membershipId: membership.id, roleId, siteId: siteA.id } });
    }

    const employee = async (email: string | null) => {
      const e = await prisma.employee.create({ data: { workspaceId }, select: { id: true } });
      const v = await prisma.employeeVersion.create({
        data: { employeeId: e.id, version: 1, firstName: "Notif", lastName: "Test", email },
        select: { id: true },
      });
      await prisma.employee.update({ where: { id: e.id }, data: { versionId: v.id } });
      return e.id;
    };
    withEmailId = await employee("notif-recipient@test.local");
    withoutEmailId = await employee(null);

    faToken = (await loginAs(server, FA_EMAIL, PASSWORD)).accessToken;
    readerToken = (await loginAs(server, READER_EMAIL, PASSWORD)).accessToken;
    officeToken = (await loginAs(server, OFFICE_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { groupId: { in: groupIds } } });
    await prisma.notificationGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.employee.deleteMany({ where: { id: { in: [withEmailId, withoutEmailId] } } });
    await prisma.user.deleteMany({ where: { email: { in: [FA_EMAIL, READER_EMAIL, OFFICE_EMAIL] } } });
    await prisma.role.deleteMany({ where: { name: "notif-test-sender", isSystem: false } });
    await server.close();
  });

  async function createGroup(input: Record<string, unknown>, token = faToken) {
    const res = await rpcCall(server, "notificationGroup/create", { siteId: siteA.id, ...input }, token);
    expect(res.statusCode).toBe(200);
    const group = res.json as GroupJson;
    groupIds.push(group.id);
    return group;
  }

  it("groups: admin creates with members, reader cannot, duplicate name conflicts, update replaces members", async () => {
    const group = await createGroup({ name: "notif-test-ops", memberIds: [withEmailId, withoutEmailId] });
    expect(group.channels).toEqual(["EMAIL"]);
    expect(group.members.map((m) => m.id).sort()).toEqual([withEmailId, withoutEmailId].sort());

    const denied = await rpcCall(server, "notificationGroup/create", { siteId: siteA.id, name: "notif-test-x" }, readerToken);
    expect(denied.statusCode).toBe(403);

    const dup = await rpcCall(server, "notificationGroup/create", { siteId: siteA.id, name: "notif-test-ops" }, faToken);
    expect(dup.statusCode).toBe(409);

    const updated = await rpcCall(server, "notificationGroup/update", { id: group.id, memberIds: [withEmailId] }, faToken);
    expect(updated.statusCode).toBe(200);
    expect((updated.json as GroupJson).members.map((m) => m.id)).toEqual([withEmailId]);

    const listed = await rpcCall(server, "notificationGroup/list", { siteId: siteA.id }, readerToken);
    expect(listed.statusCode).toBe(200);
    expect((listed.json as { data: GroupJson[] }).data.some((g) => g.id === group.id)).toBe(true);
  });

  it("send: delivers per member per channel, skips members without an address, logs and emits", async () => {
    const group = await createGroup({ name: "notif-test-send", memberIds: [withEmailId, withoutEmailId] });
    const sends: Array<{ to: string; subject: string }> = [];
    const events: NotificationEvent[] = [];
    notification.setChannelAdapter("EMAIL", {
      async send(to, message) {
        sends.push({ to, subject: message.subject });
        return { ok: true, providerMessageId: "msg-1" };
      },
    });
    notification.setNotificationEventSink((e) => {
      events.push(e);
    });
    try {
      const res = await rpcCall(server, "notification/send", { siteId: siteA.id, groupIds: [group.id], subject: "Hello", body: "Line 1" }, officeToken);
      expect(res.statusCode).toBe(200);
      const sent = res.json as NotificationJson;
      expect(sent.source).toBe("MANUAL");
      expect(sends).toEqual([{ to: "notif-recipient@test.local", subject: "Hello" }]);
      const byEmployee = Object.fromEntries(sent.deliveries.map((d) => [d.employeeId, d]));
      expect(byEmployee[withEmailId]).toMatchObject({ channel: "EMAIL", status: "SENT", providerMessageId: "msg-1" });
      expect(byEmployee[withoutEmailId]).toMatchObject({ channel: "EMAIL", status: "SKIPPED", address: null });

      await new Promise((r) => setImmediate(r));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: "sent", notificationId: sent.id, groupId: group.id, siteId: siteA.id, workspaceId, sent: 1, skipped: 1, failed: 0 });

      // Reader cannot send; office can read the log.
      const denied = await rpcCall(server, "notification/send", { siteId: siteA.id, groupIds: [group.id], subject: "x", body: "y" }, readerToken);
      expect(denied.statusCode).toBe(403);
      const log = await rpcCall(server, "notification/list", { siteId: siteA.id, groupId: group.id }, officeToken);
      expect((log.json as { data: NotificationJson[] }).data.map((n) => n.id)).toEqual([sent.id]);
    } finally {
      notification.setNotificationEventSink(null);
    }
  });

  it("send: groups and people merge, each person once; people-only sends need a site", async () => {
    const group = await createGroup({ name: "notif-test-merge", memberIds: [withEmailId] });
    const sends: string[] = [];
    notification.setChannelAdapter("EMAIL", {
      async send(to) {
        sends.push(to);
        return { ok: true, providerMessageId: "m" };
      },
    });
    // withEmailId is in the group AND listed directly → one delivery; withoutEmailId direct → skipped.
    const merged = await notification.send({
      groupIds: [group.id],
      employeeIds: [withEmailId, withoutEmailId],
      subject: "M",
      body: "B",
    });
    if (!("data" in merged)) throw new Error(merged.error);
    expect(merged.data.deliveries).toHaveLength(2);
    expect(sends).toEqual(["notif-recipient@test.local"]);
    expect(merged.data.groupName).toBe("notif-test-merge");

    const direct = await notification.send({ siteId: siteA.id, employeeIds: [withEmailId], subject: "D", body: "B" });
    if (!("data" in direct)) throw new Error(direct.error);
    expect(direct.data).toMatchObject({ groupId: null, groupName: null });
    expect(direct.data.deliveries[0]).toMatchObject({ employeeId: withEmailId, channel: "EMAIL", status: "SENT" });

    const noSite = await notification.send({ employeeIds: [withEmailId], subject: "D", body: "B" });
    expect("error" in noSite && noSite.code).toBe("NO_RECIPIENTS");
  });

  it("send: dedupeKey makes a repeat return the original; a channel with no provider is SKIPPED and emits failed", async () => {
    const group = await createGroup({ name: "notif-test-dedupe", channels: ["SMS"], memberIds: [withEmailId] });
    const events: NotificationEvent[] = [];
    notification.setNotificationEventSink((e) => {
      events.push(e);
    });
    try {
      const cause = { correlationId: "root", causationId: "parent", hop: 1 };
      const first = await notification.send({
        groupIds: [group.id], subject: "S", body: "B", dedupeKey: "notif-test-key", sourceType: "automation", sourceRef: "auto-1", cause });
      const again = await notification.send({
        groupIds: [group.id], subject: "S", body: "B", dedupeKey: "notif-test-key" });
      expect("data" in first && "data" in again && again.data.id === first.data.id && again.deduped === true).toBe(true);
      if (!("data" in first)) throw new Error(first.error);
      expect(first.data.deliveries).toHaveLength(1);
      expect(first.data.deliveries[0]).toMatchObject({ channel: "SMS", status: "SKIPPED", employeeId: withEmailId });

      await new Promise((r) => setImmediate(r));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: "failed", source: "SYSTEM", sourceType: "automation", sourceRef: "auto-1", sent: 0, skipped: 1, cause });
    } finally {
      notification.setNotificationEventSink(null);
    }
  });
});

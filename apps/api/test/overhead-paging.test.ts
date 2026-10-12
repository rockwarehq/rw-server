import prisma from "@rw/db";
import type { AnnouncementMessage } from "@rw/runtime/announce-subjects";
import { announcements } from "@rw/services/device/gateway/index";
import * as paging from "@rw/services/paging/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const ADMIN_EMAIL = "paging-admin@test.local";
const MANAGER_EMAIL = "paging-manager@test.local";
const VIEWER_EMAIL = "paging-viewer@test.local";
const PASSWORD = "paging-test-password-1";

type PageJson = { id: string; name: string; priority: string; repeat: number; chimeBefore: string | null };
type LogJson = {
  id: string;
  status: string;
  error: string | null;
  pageName: string | null;
  sentByUserId: string | null;
  sentByName: string | null;
  source: string;
  sourceType: string | null;
  sourceRef: string | null;
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("overhead paging", () => {
  let server: TestServer;
  let siteId: string;
  let onlineId: string;
  let offlineId: string;
  let adminToken: string;
  let managerToken: string;
  let viewerToken: string;
  const published: Array<{ gatewayId: string; message: AnnouncementMessage }> = [];

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    siteId = (await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true } })).id;

    const gateway = (name: string, status: "ONLINE" | "OFFLINE") =>
      prisma.gateway
        .create({ data: { name, serialNumber: `PAGING-TEST-${name}`, siteId, status }, select: { id: true } })
        .then((g) => g.id);
    onlineId = await gateway("paging-test-online", "ONLINE");
    offlineId = await gateway("paging-test-offline", "OFFLINE");

    await makeUser(ADMIN_EMAIL, PASSWORD, { plants: [{ siteId, level: "ADMIN" }] });
    await makeUser(MANAGER_EMAIL, PASSWORD, { plants: [{ siteId, level: "MANAGE" }] });
    await makeUser(VIEWER_EMAIL, PASSWORD, { plants: [{ siteId, level: "VIEW" }] });
    adminToken = (await loginAs(server, ADMIN_EMAIL, PASSWORD)).accessToken;
    managerToken = (await loginAs(server, MANAGER_EMAIL, PASSWORD)).accessToken;
    viewerToken = (await loginAs(server, VIEWER_EMAIL, PASSWORD)).accessToken;

    announcements.setAnnouncementSink((gatewayId, message) => void published.push({ gatewayId, message }));
  }, 30_000);

  afterAll(async () => {
    announcements.setAnnouncementSink(null);
    await prisma.overheadPageLog.deleteMany({ where: { gatewayIds: { hasSome: [onlineId, offlineId] } } });
    await prisma.overheadPage.deleteMany({ where: { siteId, name: { startsWith: "paging-test" } } });
    await prisma.gateway.deleteMany({ where: { id: { in: [onlineId, offlineId] } } });
    await prisma.user.deleteMany({ where: { email: { in: [ADMIN_EMAIL, MANAGER_EMAIL, VIEWER_EMAIL] } } });
    await server.close();
  });

  const tornado = () => ({
    siteId,
    name: "paging-test-tornado",
    text: "Tornado warning. Go to the shelter now.",
    gatewayIds: [onlineId],
    priority: "EMERGENCY",
    chimeBefore: "attention",
    repeat: 10,
  });

  it("saved pages: admins write, managers and viewers read, names are unique, gateways must be on the site", async () => {
    const created = await rpcCall(server, "overheadPage/create", tornado(), adminToken);
    expect(created.statusCode).toBe(200);
    expect(created.json).toMatchObject({ priority: "EMERGENCY", repeat: 10, chimeBefore: "attention" });

    expect((await rpcCall(server, "overheadPage/create", { ...tornado(), name: "paging-test-x" }, managerToken)).statusCode).toBe(403);
    expect((await rpcCall(server, "overheadPage/create", tornado(), adminToken)).statusCode).toBe(409);
    const unknownGateway = await rpcCall(
      server,
      "overheadPage/create",
      { ...tornado(), name: "paging-test-y", gatewayIds: ["00000000-0000-4000-8000-000000000000"] },
      adminToken,
    );
    expect(unknownGateway.statusCode).toBe(404);

    const listed = await rpcCall(server, "overheadPage/list", { siteId }, viewerToken);
    expect(listed.statusCode).toBe(200);
    expect((listed.json as { data: PageJson[] }).data.map((p) => p.name)).toContain("paging-test-tornado");
  });

  it("sending a saved page: managers can, viewers can't; it's published as saved and logged", async () => {
    const page = (await rpcCall(server, "overheadPage/list", { siteId }, adminToken)).json as { data: PageJson[] };
    const tornadoPage = page.data.find((p) => p.name === "paging-test-tornado");
    if (!tornadoPage) throw new Error("tornado page missing");

    expect((await rpcCall(server, "overheadPage/sendSaved", { id: tornadoPage.id }, viewerToken)).statusCode).toBe(403);

    published.length = 0;
    const sent = await rpcCall(server, "overheadPage/sendSaved", { id: tornadoPage.id }, managerToken);
    expect(sent.statusCode).toBe(200);
    const log = sent.json as LogJson;
    expect(log).toMatchObject({ status: "SENT", error: null, pageName: "paging-test-tornado" });
    expect(published).toEqual([
      {
        gatewayId: onlineId,
        message: {
          id: log.id,
          text: "Tornado warning. Go to the shelter now.",
          priority: "emergency",
          chimeBefore: "attention",
          repeat: 10,
        },
      },
    ]);
  });

  it("a one-off page to an offline gateway is logged PARTIAL and shows first in the log", async () => {
    const sent = await rpcCall(
      server,
      "overheadPage/send",
      { siteId, text: "Forklift to dock 3", gatewayIds: [onlineId, offlineId], chimeBefore: "off" },
      managerToken,
    );
    expect(sent.statusCode).toBe(200);
    expect(sent.json).toMatchObject({ status: "PARTIAL", error: "Not announced on: paging-test-offline (offline)" });

    const logs = await rpcCall(server, "overheadPage/logList", { siteId, limit: 5 }, viewerToken);
    expect(logs.statusCode).toBe(200);
    const first = (logs.json as { data: LogJson[] }).data[0];
    expect(first).toMatchObject({ id: (sent.json as LogJson).id, pageName: null });
    expect(first.sentByUserId).toBeTruthy();
  });

  it("archived pages can't be sent; options lists voices and chimes", async () => {
    const page = (await rpcCall(server, "overheadPage/create", { ...tornado(), name: "paging-test-old" }, adminToken))
      .json as PageJson;
    expect((await rpcCall(server, "overheadPage/archive", { id: page.id }, managerToken)).statusCode).toBe(403);
    expect((await rpcCall(server, "overheadPage/archive", { id: page.id }, adminToken)).statusCode).toBe(200);
    expect((await rpcCall(server, "overheadPage/sendSaved", { id: page.id }, managerToken)).statusCode).toBe(404);

    const options = await rpcCall(server, "overheadPage/options", {}, viewerToken);
    expect(options.json).toMatchObject({ chimes: ["alert", "attention", "end"] });
    expect((options.json as { voices: string[] }).voices).toContain("am_onyx");
  });

  it("logs who sent each page: a person on the paging page, or an automation", async () => {
    const manual = (
      await rpcCall(server, "overheadPage/send", { siteId, text: "Manual page", gatewayIds: [onlineId] }, managerToken)
    ).json as LogJson;
    expect(manual).toMatchObject({ source: "MANUAL", sourceType: "user" });
    expect(manual.sourceRef).toBe(manual.sentByUserId);

    const automationId = "11111111-2222-4333-8444-555555555555";
    await paging.sendAutomationPage({
      siteId,
      gatewayIds: [onlineId],
      message: { id: "evt-1:auto:0", text: "Supervisor needed at STN-07.", priority: "high" },
      automation: { id: automationId, label: "paging-test automation" },
    });
    const logs = (await rpcCall(server, "overheadPage/logList", { siteId, limit: 1 }, viewerToken)).json as {
      data: LogJson[];
    };
    expect(logs.data[0]).toMatchObject({
      text: "Supervisor needed at STN-07.",
      status: "SENT",
      source: "SYSTEM",
      sourceType: "automation",
      sourceRef: automationId,
      sentByName: "paging-test automation",
      sentByUserId: null,
    });
  });
});

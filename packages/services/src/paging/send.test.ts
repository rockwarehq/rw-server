import { beforeEach, describe, expect, it, vi } from "vitest";

// Manual overhead pages: the gateway message built from a page, the log status
// from what the gateways heard, and saved-page sends. Prisma is mocked; delivery
// goes through the real gateway announcements service with a capturing sink.
const db = vi.hoisted(() => ({
  gateway: { findMany: vi.fn() },
  overheadPage: { findUnique: vi.fn() },
  overheadPageLog: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
}));
vi.mock("@rw/db", async (importOriginal) => ({ ...(await importOriginal<object>()), default: db }));

const { setAnnouncementSink } = await import("../device/gateway/announce.js");
const { sendPage, sendSavedPage, toAnnouncement } = await import("./send.js");

const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const published: Array<{ gatewayId: string; message: Record<string, unknown> }> = [];

beforeEach(() => {
  published.length = 0;
  db.gateway.findMany.mockReset();
  db.overheadPage.findUnique.mockReset();
  db.overheadPageLog.create.mockClear();
  setAnnouncementSink((gatewayId, message) => void published.push({ gatewayId, message: { ...message } }));
});

describe("overhead page message", () => {
  it("maps saved settings onto the gateway message", () => {
    expect(
      toAnnouncement("log-1", {
        text: " Tornado warning. Go to the shelter. ",
        gatewayIds: ["gw1"],
        priority: "EMERGENCY",
        chimeBefore: "attention",
        chimeAfter: "off",
        repeat: 10,
        voice: "bm_george",
        speed: 0.9,
      }),
    ).toEqual({
      id: "log-1",
      text: "Tornado warning. Go to the shelter.",
      priority: "emergency",
      chimeBefore: "attention",
      chimeAfter: false,
      repeat: 10,
      voice: "bm_george",
      speed: 0.9,
    });
  });

  it("leaves unset settings to the gateway", () => {
    expect(toAnnouncement("log-1", { text: "Hi", gatewayIds: ["gw1"], chimeBefore: null, voice: "" })).toEqual({
      id: "log-1",
      text: "Hi",
    });
  });
});

describe("sending an overhead page", () => {
  it("logs SENT when every gateway heard it, with the log id as the message id", async () => {
    db.gateway.findMany.mockResolvedValue([{ id: "gw1", name: "Line 1", status: "ONLINE" }]);
    const { data } = await sendPage({
      siteId: SITE,
      text: "Tornado",
      gatewayIds: ["gw1", "gw1"],
      priority: "EMERGENCY",
      repeat: 10,
      sentByUserId: "user-1",
      sentByName: "Pat Lee",
    });
    expect(data).toMatchObject({
      status: "SENT",
      error: null,
      gatewayIds: ["gw1"],
      priority: "EMERGENCY",
      repeat: 10,
      sentByName: "Pat Lee",
    });
    expect(published).toEqual([
      { gatewayId: "gw1", message: { id: data.id, text: "Tornado", priority: "emergency", repeat: 10 } },
    ]);
  });

  it("logs PARTIAL when some gateways were offline or disabled", async () => {
    db.gateway.findMany.mockResolvedValue([
      { id: "gw1", name: "Line 1", status: "ONLINE" },
      { id: "gw2", name: "Line 2", status: "OFFLINE" },
    ]);
    const { data } = await sendPage({ siteId: SITE, text: "Hi", gatewayIds: ["gw1", "gw2"] });
    expect(data).toMatchObject({ status: "PARTIAL", error: "Not announced on: Line 2 (offline)" });
  });

  it("logs FAILED when no gateway heard it, or delivery couldn't start", async () => {
    db.gateway.findMany.mockResolvedValue([{ id: "gw1", name: "Line 1", status: "DISABLED" }]);
    expect((await sendPage({ siteId: SITE, text: "Hi", gatewayIds: ["gw1"] })).data).toMatchObject({
      status: "FAILED",
      error: "Not announced on: Line 1 (disabled)",
    });

    setAnnouncementSink(null);
    expect((await sendPage({ siteId: SITE, text: "Hi", gatewayIds: ["gw1"] })).data).toMatchObject({
      status: "FAILED",
      error: "Announcements need NATS, which is not connected",
    });
    expect(db.overheadPageLog.create).toHaveBeenCalledTimes(2);
  });

  it("sends a saved page as saved, and refuses an archived one", async () => {
    db.gateway.findMany.mockResolvedValue([{ id: "gw1", name: "Line 1", status: "ONLINE" }]);
    db.overheadPage.findUnique.mockResolvedValue({
      id: "page-1",
      siteId: SITE,
      name: "Tornado",
      text: "Tornado warning",
      gatewayIds: ["gw1"],
      priority: "EMERGENCY",
      chimeBefore: "attention",
      chimeAfter: null,
      repeat: 10,
      voice: null,
      speed: null,
      archivedAt: null,
    });
    const result = await sendSavedPage({ id: "page-1", sentByName: "Pat Lee" });
    expect(result).toMatchObject({ data: { pageId: "page-1", pageName: "Tornado", status: "SENT" } });
    expect(published[0].message).toMatchObject({ chimeBefore: "attention", repeat: 10, priority: "emergency" });

    db.overheadPage.findUnique.mockResolvedValue({ id: "page-1", archivedAt: new Date() });
    expect(await sendSavedPage({ id: "page-1" })).toMatchObject({ code: "OVERHEAD_PAGE_NOT_FOUND" });
  });
});

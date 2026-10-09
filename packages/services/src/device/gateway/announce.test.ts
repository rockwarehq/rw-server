import { beforeEach, describe, expect, it, vi } from "vitest";

// announce() resolves the site's gateways and hands each message to the sink
// (NATS in apps/api). Prisma is mocked: this checks targeting and reporting.
const db = vi.hoisted(() => ({ gateway: { findMany: vi.fn() } }));
vi.mock("@rw/db", async (importOriginal) => ({ ...(await importOriginal<object>()), default: db }));

const { announce, setAnnouncementSink } = await import("./announce.js");

const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sent: Array<{ gatewayId: string; text: string }> = [];

beforeEach(() => {
  sent.length = 0;
  db.gateway.findMany.mockReset();
  setAnnouncementSink((gatewayId, message) => void sent.push({ gatewayId, text: message.text }));
});

describe("gateway announcements", () => {
  it("sends to each gateway on the site", async () => {
    db.gateway.findMany.mockResolvedValue([
      { id: "gw1", name: "Line 1", status: "ONLINE" },
      { id: "gw2", name: "Line 2", status: "ONLINE" },
    ]);
    const result = await announce({
      gatewayIds: ["gw1", "gw2", "gw1"],
      siteId: SITE,
      message: { text: " Machine 226 is down " },
    });
    expect(result).toEqual({ data: { gatewayIds: ["gw1", "gw2"] } });
    expect(sent).toEqual([
      { gatewayId: "gw1", text: "Machine 226 is down" },
      { gatewayId: "gw2", text: "Machine 226 is down" },
    ]);
    expect(db.gateway.findMany.mock.lastCall?.[0].where).toEqual({ id: { in: ["gw1", "gw2"] }, siteId: SITE });
  });

  it("rejects gateways that aren't on the site", async () => {
    db.gateway.findMany.mockResolvedValue([{ id: "gw1", name: "Line 1", status: "ONLINE" }]);
    const result = await announce({ gatewayIds: ["gw1", "other"], siteId: SITE, message: { text: "hi" } });
    expect(result).toEqual({ code: "GATEWAY_NOT_FOUND", error: "Gateway not found on this site: other" });
    expect(sent).toEqual([]);
  });

  it("still sends to the rest, but reports offline and disabled gateways", async () => {
    db.gateway.findMany.mockResolvedValue([
      { id: "gw1", name: "Line 1", status: "ONLINE" },
      { id: "gw2", name: "Line 2", status: "OFFLINE" },
      { id: "gw3", name: "Line 3", status: "DISABLED" },
    ]);
    const result = await announce({ gatewayIds: ["gw1", "gw2", "gw3"], message: { text: "hi" } });
    expect(result).toEqual({
      code: "GATEWAY_UNAVAILABLE",
      error: "Not announced on: Line 2 (offline), Line 3 (disabled)",
    });
    // offline is still published: its status may be stale, and the gateway drops it if it really is offline
    expect(sent.map((s) => s.gatewayId)).toEqual(["gw1", "gw2"]);
  });

  it("needs text, a gateway, and a connected sink", async () => {
    expect(await announce({ gatewayIds: ["gw1"], message: { text: "  " } })).toMatchObject({
      code: "ANNOUNCE_TEXT_REQUIRED",
    });
    expect(await announce({ gatewayIds: [], message: { text: "hi" } })).toMatchObject({ code: "ANNOUNCE_NO_GATEWAYS" });
    setAnnouncementSink(null);
    expect(await announce({ gatewayIds: ["gw1"], message: { text: "hi" } })).toMatchObject({
      code: "ANNOUNCE_UNAVAILABLE",
    });
  });
});

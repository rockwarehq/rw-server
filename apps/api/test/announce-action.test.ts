import type { ActionContext } from "@rw/automations";
import { deriveAnnounceSubject } from "@rw/runtime/announce-subjects";
import { describe, expect, it, vi } from "vitest";

// The "announce" automation action: editor inputs -> the gateway's message. The
// services are mocked (no DB/NATS); delivery and logging are tested in services.
const announce = vi.hoisted(() => vi.fn());
const sendAutomationPage = vi.hoisted(() => vi.fn());
vi.mock("@rw/services/device/gateway/index", () => ({ announcements: { announce } }));
vi.mock("@rw/services/paging/index", () => ({ sendAutomationPage }));

const { buildAnnouncement, handler } = await import("../src/automations/actions/announce.js");

const ctx = {
  automation: { id: "auto-1", label: "Down alert" },
  event: { id: "evt-9", partition: "site-1", payload: {} },
  eventId: "evt-9",
  actionIdx: 2,
} as unknown as ActionContext;

describe("announce automation action", () => {
  it("maps editor inputs onto the gateway message", () => {
    const message = buildAnnouncement(
      {
        text: " Machine 226 is down ",
        voice: "af_bella",
        speed: "0.9",
        chimeBefore: "on",
        chimeAfter: "off",
        repeat: 3,
        priority: "emergency",
        expiresInSeconds: 30,
      },
      ctx,
      1_000,
    );
    expect(message).toEqual({
      id: "evt-9:auto-1:2",
      text: "Machine 226 is down",
      voice: "af_bella",
      speed: 0.9,
      chimeBefore: true,
      chimeAfter: false,
      repeat: 3,
      priority: "emergency",
      expiresAt: 31_000,
    });
  });

  it("passes a picked chime by name; 'on' from older automations means the gateway's chime", () => {
    expect(buildAnnouncement({ text: "Hi", chimeBefore: "attention", chimeAfter: "End" }, ctx)).toMatchObject({
      chimeBefore: "attention",
      chimeAfter: "end",
    });
    expect(buildAnnouncement({ text: "Hi", chimeBefore: "on", chimeAfter: "off" }, ctx)).toMatchObject({
      chimeBefore: true,
      chimeAfter: false,
    });
  });

  it("leaves blank inputs out so the gateway uses its defaults", () => {
    const message = buildAnnouncement({ text: "Hi", voice: "", speed: "", chimeBefore: "", priority: "" }, ctx);
    expect(message).toEqual({ id: "evt-9:auto-1:2", text: "Hi" });
  });

  it("sends to the picked gateways on the event's site, logged as sent by this automation", async () => {
    sendAutomationPage.mockResolvedValue({ data: { status: "SENT", error: null } });
    await handler.versions["1"].run({ gatewayIds: ["gw1"], text: "Hi" }, ctx);
    expect(sendAutomationPage).toHaveBeenLastCalledWith({
      siteId: "site-1",
      gatewayIds: ["gw1"],
      message: { id: "evt-9:auto-1:2", text: "Hi" },
      automation: { id: "auto-1", label: "Down alert" },
    });
  });

  it("fails the run when a speaker missed it", async () => {
    sendAutomationPage.mockResolvedValue({ data: { status: "PARTIAL", error: "Not announced on: Line 2 (offline)" } });
    await expect(handler.versions["1"].run({ gatewayIds: ["gw2"], text: "Hi" }, ctx)).rejects.toThrow(
      "Not announced on: Line 2 (offline)",
    );
    await expect(handler.versions["1"].run({ gatewayIds: [], text: "Hi" }, ctx)).rejects.toThrow("at least one gateway");
  });

  it("announces without logging for a site-less (legacy global) automation", async () => {
    announce.mockResolvedValue({ code: "GATEWAY_UNAVAILABLE", error: "Not announced on: Line 2 (offline)" });
    const globalCtx = { ...ctx, event: { ...ctx.event, partition: undefined } } as unknown as ActionContext;
    sendAutomationPage.mockClear();
    await expect(handler.versions["1"].run({ gatewayIds: ["gw2"], text: "Hi" }, globalCtx)).rejects.toThrow(
      "GATEWAY_UNAVAILABLE: Not announced on: Line 2 (offline)",
    );
    expect(announce).toHaveBeenLastCalledWith({ gatewayIds: ["gw2"], message: { id: "evt-9:auto-1:2", text: "Hi" } });
    expect(sendAutomationPage).not.toHaveBeenCalled();
  });

  it("publishes on the subject the gateway subscribes to", () => {
    expect(deriveAnnounceSubject("mock-gateway-001")).toBe("announce.mock-gateway-001");
  });
});

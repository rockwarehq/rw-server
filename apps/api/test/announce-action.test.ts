import type { ActionContext } from "@rw/automations";
import { deriveAnnounceSubject } from "@rw/runtime/announce-subjects";
import { describe, expect, it, vi } from "vitest";

// The "announce" automation action: editor inputs -> the gateway's message. The
// gateway service is mocked (no DB/NATS); its targeting is tested in services.
const announce = vi.hoisted(() => vi.fn());
vi.mock("@rw/services/device/gateway/index", () => ({ announcements: { announce } }));

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

  it("leaves blank inputs out so the gateway uses its defaults", () => {
    const message = buildAnnouncement({ text: "Hi", voice: "", speed: "", chimeBefore: "", priority: "" }, ctx);
    expect(message).toEqual({ id: "evt-9:auto-1:2", text: "Hi" });
  });

  it("sends to the picked gateways on the event's site", async () => {
    announce.mockResolvedValue({ data: { gatewayIds: ["gw1"] } });
    await handler.versions["1"].run({ gatewayIds: ["gw1"], text: "Hi" }, ctx);
    expect(announce).toHaveBeenLastCalledWith({
      gatewayIds: ["gw1"],
      siteId: "site-1",
      message: { id: "evt-9:auto-1:2", text: "Hi" },
    });
  });

  it("fails the run when the service reports an error", async () => {
    announce.mockResolvedValue({ code: "GATEWAY_UNAVAILABLE", error: "Not announced on: Line 2 (offline)" });
    await expect(handler.versions["1"].run({ gatewayIds: ["gw2"], text: "Hi" }, ctx)).rejects.toThrow(
      "GATEWAY_UNAVAILABLE: Not announced on: Line 2 (offline)",
    );
    await expect(handler.versions["1"].run({ gatewayIds: [], text: "Hi" }, ctx)).rejects.toThrow("at least one gateway");
  });

  it("publishes on the subject the gateway subscribes to", () => {
    expect(deriveAnnounceSubject("mock-gateway-001")).toBe("announce.mock-gateway-001");
  });
});

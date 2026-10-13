import type { ActionContext } from "@rw/automations";
import { deriveAnnounceSubject } from "@rw/runtime/announce-subjects";
import { describe, expect, it, vi } from "vitest";

// The "announce" automation action: editor inputs -> the gateway's message. The
// services are mocked (no DB/NATS); delivery and logging are tested in services.
const sendAutomationPage = vi.hoisted(() => vi.fn());
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

  it("plays on every speaker at the plant when no speakers are picked, logged as sent by this automation", async () => {
    sendAutomationPage.mockResolvedValue({ data: { status: "SENT", error: null } });
    await handler.versions["1"].run({ text: "Hi" }, ctx);
    expect(sendAutomationPage).toHaveBeenLastCalledWith({
      siteId: "site-1",
      gatewayIds: [],
      message: { id: "evt-9:auto-1:2", text: "Hi" },
      automation: { id: "auto-1", label: "Down alert" },
    });
  });

  it("plays only on the picked speakers when some are picked", async () => {
    sendAutomationPage.mockResolvedValue({ data: { status: "SENT", error: null } });
    await handler.versions["1"].run({ gatewayIds: ["gw1", ""], text: "Hi" }, ctx);
    expect(sendAutomationPage).toHaveBeenLastCalledWith(expect.objectContaining({ gatewayIds: ["gw1"] }));
  });

  it("fails the run when a speaker missed it, or the plant has none", async () => {
    sendAutomationPage.mockResolvedValue({ data: { status: "PARTIAL", error: "Not announced on: Line 2 (offline)" } });
    await expect(handler.versions["1"].run({ text: "Hi" }, ctx)).rejects.toThrow("Not announced on: Line 2 (offline)");
    sendAutomationPage.mockResolvedValue({ data: { status: "FAILED", error: "This plant has no speakers (gateways) yet" } });
    await expect(handler.versions["1"].run({ text: "Hi" }, ctx)).rejects.toThrow("This plant has no speakers");
  });

  it("needs a plant", async () => {
    const globalCtx = { ...ctx, event: { ...ctx.event, partition: undefined } } as unknown as ActionContext;
    await expect(handler.versions["1"].run({ text: "Hi" }, globalCtx)).rejects.toThrow("announce needs a plant");
  });

  it("only needs the message; Speakers is optional", () => {
    expect(handler.versions["1"].inputSchema.required).toEqual(["text"]);
    expect(handler.versions["1"].inputSchema.properties.gatewayIds).toMatchObject({
      title: "Speakers",
      ref: { source: "gateways", multi: true },
    });
  });

  it("publishes on the subject the gateway subscribes to", () => {
    expect(deriveAnnounceSubject("mock-gateway-001")).toBe("announce.mock-gateway-001");
  });
});

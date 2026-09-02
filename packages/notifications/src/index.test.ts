import { describe, expect, it } from "vitest";
import { type ChannelAdapter, createNotifier, summarize } from "./index.js";

const ok: ChannelAdapter = {
  async send() {
    return { ok: true, providerMessageId: "m1" };
  },
};
const boom: ChannelAdapter = {
  async send() {
    throw new Error("provider down");
  },
};

const recipients = [
  { id: "a", addresses: { EMAIL: "a@x.test", SMS: "+1" } },
  { id: "b", addresses: { EMAIL: null } },
];
const message = { subject: "s", body: "b" };

describe("deliver", () => {
  it("sends per recipient per channel, skipping missing addresses and unconfigured channels", async () => {
    const notifier = createNotifier({ EMAIL: ok });
    const deliveries = await notifier.deliver(recipients, ["EMAIL", "SMS"], message);
    expect(deliveries.map((d) => [d.recipientId, d.channel, d.status])).toEqual([
      ["a", "EMAIL", "SENT"],
      ["b", "EMAIL", "SKIPPED"],
      ["a", "SMS", "SKIPPED"],
      ["b", "SMS", "SKIPPED"],
    ]);
    expect(deliveries[0]).toMatchObject({ address: "a@x.test", providerMessageId: "m1", error: null });
    expect(deliveries[2]?.error).toMatch(/not configured/);
    expect(summarize(deliveries)).toEqual({ sent: 1, failed: 0, skipped: 3 });
  });

  it("records a throwing or failing adapter as FAILED without throwing", async () => {
    const notifier = createNotifier({ EMAIL: boom });
    const [d] = await notifier.deliver([recipients[0]!], ["EMAIL"], message);
    expect(d).toMatchObject({ status: "FAILED", error: "provider down", providerMessageId: null });
  });

  it("setAdapter swaps a channel's provider", async () => {
    const notifier = createNotifier();
    notifier.setAdapter("SMS", ok);
    const [d] = await notifier.deliver([recipients[0]!], ["SMS"], message);
    expect(d?.status).toBe("SENT");
  });
});

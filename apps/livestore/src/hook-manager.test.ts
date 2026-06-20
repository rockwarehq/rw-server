import { describe, expect, it, vi } from "vitest";

import { HookManager } from "./hook-manager.js";
import type { LivestoreLogger, ValueEnvelope } from "./types.js";

const decoder = new TextDecoder();

const env = (value: unknown, quality: ValueEnvelope["quality"] = "good"): ValueEnvelope => ({
  value,
  quality,
  timestamp: 1000,
});

const logger: LivestoreLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeHarness(overrides: { stationEnvelope?: ValueEnvelope | null } = {}) {
  const publish = vi.fn(async (_subject: string, _payload: Uint8Array, _opts?: unknown) => {});
  const prisma = {
    graphHook: {
      findMany: vi.fn(async () => [
        {
          id: "hook-1",
          siteId: "site-1",
          name: "Cycle Complete",
          enabled: true,
          condition: {
            source: { type: "property", propertyId: "cycle-prop" },
            operator: "increases",
          },
          eventType: "imm.cycle.completed",
          eventVersion: "1",
          eventPayload: { source: "test" },
          eventContext: {
            stationId: { source: { type: "property", propertyId: "station-prop" } },
          },
          isDeleted: false,
        },
      ]),
      findUnique: vi.fn(),
    },
  };
  const jsm = {
    streams: {
      info: vi.fn(async () => ({ config: { subjects: ["livestore.events.>"] } })),
      update: vi.fn(),
      add: vi.fn(),
    },
  };
  const manager = new HookManager(prisma as never, { publish } as never, jsm as never, logger);
  const getCurrent = (propertyId: string) => {
    if (propertyId === "station-prop") return overrides.stationEnvelope ?? env("station-1");
    return null;
  };
  return { manager, publish, getCurrent };
}

describe("HookManager", () => {
  it("queues matching hook events and publishes after pending hooks are flushed", async () => {
    const { manager, publish, getCurrent } = makeHarness();
    await manager.start();

    const queued = manager.onPropertyCommitted({
      propertyId: "cycle-prop",
      previous: env(10),
      current: env(11),
    });

    expect(queued).toBe(true);
    expect(publish).not.toHaveBeenCalled();

    await manager.flushPending(getCurrent);

    expect(publish).toHaveBeenCalledOnce();
    const call = publish.mock.calls[0];
    if (!call) throw new Error("expected publish call");
    const [, payload] = call;
    const event = JSON.parse(decoder.decode(payload));
    expect(event.payload).toMatchObject({ source: "test", stationId: "station-1" });
    expect(event.context.stationId).toMatchObject({ propertyId: "station-prop", quality: "good", timestamp: 1000 });
  });

  it("skips publish when required context is not good", async () => {
    const { manager, publish, getCurrent } = makeHarness({ stationEnvelope: env("station-1", "stale") });
    await manager.start();

    expect(
      manager.onPropertyCommitted({
        propertyId: "cycle-prop",
        previous: env(10),
        current: env(11),
      }),
    ).toBe(true);

    await manager.flushPending(getCurrent);

    expect(publish).not.toHaveBeenCalled();
  });
});

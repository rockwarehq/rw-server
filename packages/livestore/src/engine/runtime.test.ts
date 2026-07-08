import type { PrismaClient } from "@rw/db";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/nats-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GraphRuntime } from "./runtime.js";

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// Deferred gate: lets a test hold an async fake open at a chosen point.
function gate() {
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

// Never-yielding consumer iterator with stop(), matching ConsumerMessages' use here.
function fakeConsumerMessages() {
  let stopped = false;
  let wake: (() => void) | null = null;
  return {
    stop() {
      stopped = true;
      wake?.();
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (!stopped) await new Promise<void>((resolve) => (wake = resolve));
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}

function fakeJsm(calls: string[]) {
  return {
    streams: {
      info: async () => ({ config: { subjects: ["covered.>"], max_age: 1, max_bytes: 1 } }),
      add: async () => ({}),
      update: async () => ({}),
    },
    consumers: {
      info: async () => {
        throw new Error("consumer not found");
      },
      add: async (stream: string) => {
        calls.push(`consumer-added:${stream}`);
        return {};
      },
    },
  } as unknown as JetStreamManager;
}

function fakeJs() {
  return {
    consumers: {
      get: async () => ({ consume: async () => fakeConsumerMessages() }),
    },
  } as unknown as JetStreamClient;
}

function fakeKv(onPut?: () => Promise<void>) {
  const store = new Map<string, string>();
  const decoder = new TextDecoder();
  const kv = {
    store,
    async get(key: string) {
      const value = store.get(key);
      return value === undefined ? null : { string: () => value };
    },
    async put(key: string, data: Uint8Array) {
      await onPut?.();
      store.set(key, decoder.decode(data));
    },
    async watch() {
      return fakeConsumerMessages();
    },
  };
  return kv as unknown as KV & { store: Map<string, string> };
}

interface PropertyRow {
  id: string;
  nodeId: string;
  name: string;
  resolverType: string;
  resolver: unknown;
  sampleRateMs: number | null;
  node?: unknown;
}

function propertyRow(id: string, nodeId: string): PropertyRow {
  return {
    id,
    nodeId,
    name: id,
    resolverType: "expr",
    resolver: { type: "expr", expression: "1" },
    sampleRateMs: null,
    node: { id: nodeId, name: nodeId, siteId: "site-1", typeRef: null, typeContext: {} },
  };
}

// Prisma fake: empty graph by default; tests override individual delegates.
function fakePrisma(calls: string[]) {
  return {
    graphNode: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        calls.push(args.where.isDeleted === false ? "kernel-load" : "reconcile-nodes");
        return [];
      },
      findFirst: async () => null,
      findUnique: async () => null,
    },
    graphProperty: {
      findMany: async () => [],
      findFirst: async () => null,
    },
    graphEdge: { findMany: async () => [] },
    graphHook: { findMany: async () => [], findUnique: async () => null },
  };
}

function makeRuntime(overrides?: {
  prisma?: ReturnType<typeof fakePrisma>;
  kv?: ReturnType<typeof fakeKv>;
  calls?: string[];
}) {
  const calls = overrides?.calls ?? [];
  const prisma = overrides?.prisma ?? fakePrisma(calls);
  const kv = overrides?.kv ?? fakeKv();
  const runtime = new GraphRuntime({
    prisma: prisma as unknown as PrismaClient,
    nc: { subscribe: () => fakeConsumerMessages() } as unknown as NatsConnection,
    jetstream: fakeJs(),
    jetstreamManager: fakeJsm(calls),
    kv,
    aggKv: fakeKv(),
    logger,
  });
  return { runtime, prisma, kv, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("start ordering", () => {
  it("ensures durables before the kernel load so first-boot events are retained", async () => {
    const { runtime, calls } = makeRuntime();
    await runtime.start();

    const firstConsumerAdd = calls.findIndex((call) => call.startsWith("consumer-added"));
    const kernelLoad = calls.indexOf("kernel-load");
    expect(firstConsumerAdd).toBeGreaterThanOrEqual(0);
    expect(kernelLoad).toBeGreaterThan(firstConsumerAdd);

    await runtime.stop();
  });
});

describe("write-behind reads", () => {
  it("getCvgValue returns the committed envelope while its KV put is still in flight", async () => {
    const putGate = gate();
    const kv = fakeKv(() => putGate.opened);
    const calls: string[] = [];
    const prisma = fakePrisma(calls);
    // One expr property, delivered via a property definition event.
    prisma.graphProperty.findFirst = async () => propertyRow("p1", "n1") as never;
    const { runtime } = makeRuntime({ prisma, kv, calls });
    await runtime.start();

    const enqueue = runtime.enqueueDefinitionChange({
      id: "evt-1",
      entity: "property",
      action: "updated",
      entityId: "p1",
      nodeId: "n1",
      siteId: "site-1",
      emittedAt: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(150);
    await enqueue;

    const envelope = { value: 42, quality: "good" as const, timestamp: 1000 };
    await runtime.commitValue("p1", envelope, "manual");

    // Put is gated open: the pending write must still be visible.
    expect(await runtime.getCvgValue("p1")).toEqual(envelope);

    putGate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await runtime.getCvgValue("p1")).toEqual(envelope); // now from KV

    await runtime.stop();
  });

  it("stop drains queued CVG puts before returning", async () => {
    const putGate = gate();
    const kv = fakeKv(() => putGate.opened);
    const calls: string[] = [];
    const prisma = fakePrisma(calls);
    prisma.graphProperty.findFirst = async () => propertyRow("p1", "n1") as never;
    const { runtime } = makeRuntime({ prisma, kv, calls });
    await runtime.start();

    const enqueue = runtime.enqueueDefinitionChange({
      id: "evt-1",
      entity: "property",
      action: "updated",
      entityId: "p1",
      nodeId: "n1",
      siteId: "site-1",
      emittedAt: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(150);
    await enqueue;

    await runtime.commitValue("p1", { value: 1, quality: "good", timestamp: 2000 }, "manual");

    let stopResolved = false;
    const stopPromise = runtime.stop().then(() => {
      stopResolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopResolved).toBe(false); // still waiting on the gated put

    putGate.release();
    await vi.advanceTimersByTimeAsync(0);
    await stopPromise;
    expect(kv.store.get("prop.p1")).toContain('"value":1');
  });
});

describe("definition apply serialization", () => {
  it("the periodic reconcile never applies concurrently with an event-driven apply", async () => {
    const calls: string[] = [];
    const prisma = fakePrisma(calls);

    // Instrument loadPropertyDefinition's query to track apply concurrency and
    // to block the first (event-driven) apply until the reconcile has fired.
    let active = 0;
    let maxActive = 0;
    const firstApplyGate = gate();
    let firstApply = true;
    prisma.graphProperty.findFirst = (async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (firstApply) {
        firstApply = false;
        await firstApplyGate.opened;
      }
      active -= 1;
      return propertyRow("p1", "n1") as never;
    }) as never;
    // Reconcile scan reports one changed property, so it has work to apply.
    prisma.graphProperty.findMany = (async (args?: { select?: unknown }) =>
      args?.select
        ? ([{ id: "p1", nodeId: "n1", node: { siteId: "site-1" } }] as never)
        : ([] as never)) as never;

    const { runtime } = makeRuntime({ prisma, calls });
    await runtime.start();

    // Event-driven apply starts and blocks inside loadPropertyDefinition.
    const enqueue = runtime.enqueueDefinitionChange({
      id: "evt-1",
      entity: "property",
      action: "updated",
      entityId: "p1",
      nodeId: "n1",
      siteId: "site-1",
      emittedAt: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(100); // coalescing window fires, apply begins

    // Reconcile tick fires while the event apply is still blocked.
    await vi.advanceTimersByTimeAsync(30_000);

    firstApplyGate.release();
    await vi.advanceTimersByTimeAsync(1_000);
    await enqueue;

    expect(maxActive).toBe(1); // applies never overlapped
    await runtime.stop();
  });
});

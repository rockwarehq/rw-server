import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TagResolver } from "./tag-resolver.js";
import type { ValueEnvelope } from "../types/index.js";

const logger = { info: () => {}, warn: () => {}, error: () => {} };

// An async iterable whose iteration immediately throws — models a consume loop
// that dies on a NATS blip.
function throwingMessages() {
  return {
    stop() {},
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<never>> {
          return Promise.reject(new Error("consumer terminated"));
        },
      };
    },
  };
}

// An async iterable that stays open forever (healthy, idle).
function idleMessages() {
  return {
    stop() {},
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<never>>(() => {}) };
    },
  };
}

const jsm = {
  streams: { info: async () => ({ config: {} }), update: async () => ({}), add: async () => ({}) },
  consumers: { info: async () => ({}), add: async () => ({}) },
} as unknown as JetStreamManager;

const sink = { commitValue: async (_id: string, _env: ValueEnvelope, _s: "tag") => {} };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TagResolver restart", () => {
  it("reopens the consumer with backoff after the consume loop errors", async () => {
    let getCalls = 0;
    const js = {
      consumers: {
        get: async () => {
          getCalls += 1;
          // First open dies immediately; the reopen stays healthy.
          return { consume: async () => (getCalls === 1 ? throwingMessages() : idleMessages()) };
        },
      },
    } as unknown as JetStreamClient;

    const resolver = new TagResolver(js, jsm, sink, logger);
    await resolver.start([]);

    // The throwing iterator rejects; the catch schedules a restart (counted now)
    // but the reopen hasn't fired yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(getCalls).toBe(1);
    expect(resolver.stats().restartsTotal).toBe(1);

    // Backoff for the first attempt is 1s — then the consumer reopens.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getCalls).toBe(2);

    resolver.stop();
  });

  it("does not restart after stop()", async () => {
    let getCalls = 0;
    const js = {
      consumers: {
        get: async () => {
          getCalls += 1;
          return { consume: async () => throwingMessages() };
        },
      },
    } as unknown as JetStreamClient;

    const resolver = new TagResolver(js, jsm, sink, logger);
    await resolver.start([]);
    await vi.advanceTimersByTimeAsync(0);
    resolver.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getCalls).toBe(1); // no reopen once stopped
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initEwmaState, initTumblingState } from "./window-fold.js";
import { WindowResolver } from "./window-resolver.js";
import type { AggState, PropertyRuntime, Quality, ValueEnvelope, WindowResolverConfig } from "../types/index.js";

const WINDOW_MS = 10_000;
const T0 = 1_700_000_000_000; // boot time; a realistic epoch ms on the WINDOW_MS grid

const tumbling = (overrides: Partial<WindowResolverConfig> = {}): WindowResolverConfig => ({
  type: "window",
  sourcePropertyId: "src",
  kind: "tumbling",
  aggregation: "avg",
  windowMs: WINDOW_MS,
  ...overrides,
});

const ewma = (alpha = 0.5): WindowResolverConfig => ({
  type: "window",
  sourcePropertyId: "src",
  kind: "ewma",
  aggregation: "avg",
  alpha,
});

const property = (id: string, resolver: WindowResolverConfig): PropertyRuntime => ({
  id,
  nodeId: "node1",
  name: id,
  resolverType: "window",
  resolver,
  sampleRateMs: null,
  current: { value: null, quality: "stale", timestamp: 0 },
});

const sample = (value: number, timestamp: number, quality: Quality = "good"): ValueEnvelope => ({
  value,
  quality,
  timestamp,
});

const getProperty = (id: string) => (id === "src" ? { resolverType: "tag" } : null);
const logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeHarness() {
  const states = new Map<string, AggState>();
  let puts = 0;
  const store = {
    get: async (id: string) => states.get(id) ?? null,
    put: async (id: string, state: AggState) => {
      puts += 1;
      states.set(id, structuredClone(state));
    },
  };
  const commits: { propertyId: string; envelope: ValueEnvelope }[] = [];
  const sink = {
    commitValue: async (propertyId: string, envelope: ValueEnvelope) => {
      commits.push({ propertyId, envelope });
    },
  };
  const evaluator = new WindowResolver(store, sink, logger);
  return { evaluator, commits, states, putCount: () => puts };
}

// Emits ride a detached promise chain; drain microtasks so commits are visible.
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("tumbling", () => {
  it("closes the bucket on the timer, emits the aggregate, and re-arms", async () => {
    const h = makeHarness();
    await h.evaluator.start([property("win", tumbling())], getProperty);

    h.evaluator.onInput("src", sample(4, T0 + 1_000));
    h.evaluator.onInput("src", sample(6, T0 + 2_000));
    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]).toMatchObject({
      propertyId: "win",
      envelope: { value: 5, quality: "good", timestamp: T0 + WINDOW_MS },
    });

    // Next bucket got no samples: the re-armed timer closes it as empty/bad.
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(h.commits).toHaveLength(2);
    expect(h.commits[1]?.envelope).toMatchObject({ value: null, quality: "bad", timestamp: T0 + 2 * WINDOW_MS });
  });

  it("drops late samples and counts them", async () => {
    const h = makeHarness();
    await h.evaluator.start([property("win", tumbling())], getProperty);

    h.evaluator.onInput("src", sample(4, T0 - 1)); // before bucketStart
    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(h.evaluator.counts().lateSamplesDropped).toBe(1);
    expect(h.commits[0]?.envelope).toMatchObject({ value: null, quality: "bad" });
  });

  it("fast-closes on a future-timestamp sample without double-emitting", async () => {
    const h = makeHarness();
    await h.evaluator.start([property("win", tumbling())], getProperty);

    h.evaluator.onInput("src", sample(4, T0 + 1_000));
    // Event time is already in the next bucket: close [T0, T0+10s) now, fold there.
    h.evaluator.onInput("src", sample(8, T0 + WINDOW_MS + 5_000));
    await settle();

    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]?.envelope).toMatchObject({ value: 4, timestamp: T0 + WINDOW_MS });

    // Advancing past the first bucket's original close must not re-emit it.
    await vi.advanceTimersByTimeAsync(2 * WINDOW_MS);
    expect(h.commits).toHaveLength(2);
    expect(h.commits[1]?.envelope).toMatchObject({ value: 8, timestamp: T0 + 2 * WINDOW_MS });
  });

  it("emits one gap marker for a multi-bucket event-time jump", async () => {
    const h = makeHarness();
    await h.evaluator.start([property("win", tumbling())], getProperty);

    h.evaluator.onInput("src", sample(4, T0 + 1_000));
    h.evaluator.onInput("src", sample(9, T0 + 45_000)); // 3 whole buckets skipped
    await settle();

    expect(h.commits).toHaveLength(2);
    expect(h.commits[0]?.envelope).toMatchObject({ value: 4, timestamp: T0 + WINDOW_MS });
    expect(h.commits[1]?.envelope).toMatchObject({
      value: null,
      quality: "bad",
      timestamp: T0 + 40_000,
      context: { count: 0, gapBuckets: 3, windowStart: T0 + 30_000, windowEnd: T0 + 40_000 },
    });
    expect(h.evaluator.counts().gapBucketsSkipped).toBe(3);
  });

  it("debounces state persistence and flushes immediately on close", async () => {
    const h = makeHarness();
    await h.evaluator.start([property("win", tumbling())], getProperty);

    h.evaluator.onInput("src", sample(4, T0 + 1_000));
    h.evaluator.onInput("src", sample(6, T0 + 1_100));
    expect(h.putCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500); // one debounced write for both folds
    expect(h.putCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(WINDOW_MS - 500); // close persists immediately
    expect(h.putCount()).toBe(2);
    expect(h.states.get("win")).toMatchObject({ bucketStart: T0 + WINDOW_MS, count: 0 });
  });
});

describe("ewma", () => {
  it("emits on every usable input, seeding from the first", async () => {
    const h = makeHarness();
    await h.evaluator.start([property("win", ewma(0.5))], getProperty);

    h.evaluator.onInput("src", sample(10, T0 + 1_000));
    h.evaluator.onInput("src", sample(20, T0 + 2_000));
    await settle();

    expect(h.commits.map((c) => c.envelope.value)).toEqual([10, 15]);
  });

  it("does not emit for bad or non-numeric samples", async () => {
    const h = makeHarness();
    await h.evaluator.start([property("win", ewma())], getProperty);

    h.evaluator.onInput("src", sample(10, T0 + 1_000, "bad"));
    h.evaluator.onInput("src", { value: "nope", quality: "good", timestamp: T0 + 2_000 });
    await settle();

    expect(h.commits).toHaveLength(0);
  });
});

describe("rehydrate", () => {
  it("resumes an open on-grid bucket and folds new samples into it", async () => {
    const h = makeHarness();
    const open = { ...initTumblingState(T0, WINDOW_MS), count: 1, sum: 4, goodCount: 1, totalCount: 1 };
    h.states.set("win", open); // bucket [T0, T0+10s)
    vi.setSystemTime(T0 + 5_000); // engine boots mid-bucket

    await h.evaluator.start([property("win", tumbling())], getProperty);
    h.evaluator.onInput("src", sample(6, T0 + 6_000));
    await vi.advanceTimersByTimeAsync(5_000); // close at T0+10s

    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]?.envelope).toMatchObject({ value: 5, timestamp: T0 + WINDOW_MS, context: { count: 2 } });
  });

  it("emits a bucket that closed while down as stale, plus a gap marker", async () => {
    const h = makeHarness();
    const expired = { ...initTumblingState(T0 - 20_000, WINDOW_MS), count: 2, sum: 8, goodCount: 2, totalCount: 2 };
    h.states.set("win", expired); // bucket [80s, 90s); engine was down until 100s

    await h.evaluator.start([property("win", tumbling())], getProperty);
    await settle();

    expect(h.commits).toHaveLength(2);
    expect(h.commits[0]?.envelope).toMatchObject({ value: 4, quality: "stale", timestamp: T0 - WINDOW_MS });
    expect(h.commits[1]?.envelope).toMatchObject({ quality: "bad", context: { gapBuckets: 1 } });
    expect(h.states.get("win")).toMatchObject({ bucketStart: T0, bucketEnd: T0 + WINDOW_MS });
  });

  it("discards persisted state on a bucket-grid mismatch", async () => {
    const h = makeHarness();
    h.states.set("win", { ...initTumblingState(T0 - 5_000, WINDOW_MS), count: 3, sum: 9 });

    // windowMs edited 10s -> 15s: the stored bucket is on the wrong grid.
    await h.evaluator.start([property("win", tumbling({ windowMs: 15_000 }))], getProperty);
    await settle();

    expect(h.commits).toHaveLength(0); // fresh bucket, nothing to emit
    h.evaluator.onInput("src", sample(5, T0 + 1_000));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.commits[0]?.envelope).toMatchObject({ value: 5, context: { count: 1 } });
  });

  it("discards persisted state on a kind mismatch", async () => {
    const h = makeHarness();
    h.states.set("win", { ...initEwmaState(), value: 42, lastInputTs: T0 - 1_000 });

    await h.evaluator.start([property("win", tumbling())], getProperty);
    h.evaluator.onInput("src", sample(5, T0 + 1_000));
    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(h.commits[0]?.envelope).toMatchObject({ value: 5, context: { count: 1 } });
  });

  it("discards persisted state folded from a different source property", async () => {
    const h = makeHarness();
    h.states.set("win", {
      kind: "ewma",
      value: 42,
      lastInputTs: T0 - 1_000,
      lastInputQuality: "good",
      sourcePropertyId: "other-src",
    });

    await h.evaluator.start([property("win", ewma(1))], getProperty); // config source: "src"
    await settle();

    // Fresh state: the first sample fully defines the value (alpha=1) instead
    // of being contaminated by the other source's 42.
    h.evaluator.onInput("src", sample(5, T0 + 1_000));
    await settle();
    expect(h.commits.at(-1)?.envelope).toMatchObject({ value: 5 });
  });

  it("keeps persisted state stamped with the same source, and stamps persists", async () => {
    const h = makeHarness();
    h.states.set("win", {
      kind: "ewma",
      value: 40,
      lastInputTs: T0 - 1_000,
      lastInputQuality: "good",
      sourcePropertyId: "src",
    });

    await h.evaluator.start([property("win", ewma(0.5))], getProperty);
    h.evaluator.onInput("src", sample(20, T0 + 1_000));
    await vi.advanceTimersByTimeAsync(600); // persist debounce

    expect(h.commits.at(-1)?.envelope).toMatchObject({ value: 30 }); // folded onto 40, not fresh
    expect(h.states.get("win")).toMatchObject({ sourcePropertyId: "src" });
  });

  it("re-emits a long-idle EWMA as stale until fresh input arrives", async () => {
    const h = makeHarness();
    h.states.set("win", { kind: "ewma", value: 7, lastInputTs: T0 - 2 * 60 * 60 * 1000, lastInputQuality: "good" });

    await h.evaluator.start([property("win", ewma())], getProperty);
    await settle();

    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]?.envelope).toMatchObject({ value: 7, quality: "stale" });
  });
});

describe("lifecycle", () => {
  it("skips invalid configs without throwing", async () => {
    const h = makeHarness();
    await h.evaluator.start([property("win", ewma(2))], getProperty); // alpha out of range

    expect(h.evaluator.counts().windowCount).toBe(0);
    h.evaluator.onInput("src", sample(5, T0 + 1_000));
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(h.commits).toHaveLength(0);
  });

  it("stop flushes state, clears timers, and ignores further input", async () => {
    const h = makeHarness();
    await h.evaluator.start([property("win", tumbling())], getProperty);
    h.evaluator.onInput("src", sample(4, T0 + 1_000));

    await h.evaluator.stop();
    expect(h.states.get("win")).toMatchObject({ count: 1, sum: 4 }); // pending state flushed

    h.evaluator.onInput("src", sample(9, T0 + 2_000));
    await vi.advanceTimersByTimeAsync(5 * WINDOW_MS);
    expect(h.commits).toHaveLength(0); // no close timer fired, no fold happened
  });
});

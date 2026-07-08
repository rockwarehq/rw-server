import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Scheduler } from "./scheduler.js";

const logger = { info: () => {}, warn: vi.fn(), error: vi.fn() };

// Graph: src -> win -> expr, with win as a barrier (window property).
function makeScheduler(options: {
  dependents: Record<string, string[]>;
  topo: string[];
  barriers?: string[];
  onEvaluate?: (id: string, scheduler: Scheduler) => void;
  afterSettled?: () => Promise<void>;
}) {
  const evaluated: string[] = [];
  const barriers = new Set(options.barriers ?? []);
  const topoIndex = new Map(options.topo.map((id, index) => [id, index]));
  const scheduler: Scheduler = new Scheduler(
    (id) => options.dependents[id] ?? [],
    (id) => topoIndex.get(id),
    async (id) => {
      evaluated.push(id);
      options.onEvaluate?.(id, scheduler);
    },
    (id) => barriers.has(id),
    logger,
    options.afterSettled,
  );
  return { scheduler, evaluated };
}

beforeEach(() => {
  vi.useFakeTimers();
  logger.warn.mockClear();
  logger.error.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("barrier", () => {
  const dependents = { src: ["win"], win: ["expr"], expr: [] };
  const topo = ["src", "win", "expr"];

  it("a source change does not dirty the window or anything behind it", async () => {
    const { scheduler, evaluated } = makeScheduler({ dependents, topo, barriers: ["win"] });
    scheduler.markDirty("src");
    await vi.advanceTimersByTimeAsync(100);
    expect(evaluated).toEqual([]);
  });

  it("the window's own commit dirties its dependents normally", async () => {
    const { scheduler, evaluated } = makeScheduler({ dependents, topo, barriers: ["win"] });
    scheduler.markDirty("win");
    await vi.advanceTimersByTimeAsync(100);
    expect(evaluated).toEqual(["expr"]);
  });

  it("markDirtyMany evaluates the listed properties but stops descent at barriers", async () => {
    const { scheduler, evaluated } = makeScheduler({ dependents, topo, barriers: ["win"] });
    scheduler.markDirtyMany(["src"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(evaluated).toEqual(["src"]);
  });
});

describe("unorderable dirty ids", () => {
  it("ids missing from the topo order (deleted/quarantined) are dropped, the rest evaluate", async () => {
    const { scheduler, evaluated } = makeScheduler({
      dependents: { a: [] },
      topo: ["a"], // "ghost" has no topo position
    });
    scheduler.markDirtyMany(["ghost", "a"]);
    await vi.advanceTimersByTimeAsync(200);

    expect(evaluated).toEqual(["a"]);
    // No leftover work: the dirty set settled, so no further flush is scheduled.
    expect(scheduler.flushStats().dirtySetSize).toBe(0);
  });
});

describe("failure containment", () => {
  it("an evaluate failure skips that property but the flush continues and completes", async () => {
    const { scheduler, evaluated } = makeScheduler({
      dependents: { a: [], b: [], c: [] },
      topo: ["a", "b", "c"],
      onEvaluate: (id) => {
        if (id === "b") throw new Error("kv down");
      },
    });
    scheduler.markDirtyMany(["a", "b", "c"]);
    await vi.advanceTimersByTimeAsync(200);

    expect(evaluated).toEqual(["a", "b", "c"]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: "b" }),
      expect.stringContaining("evaluate failed"),
    );
    expect(scheduler.flushStats().evaluateFailures).toBe(1);
  });

  it("the scheduler keeps working after a failed flush", async () => {
    let fail = true;
    const { scheduler, evaluated } = makeScheduler({
      dependents: { a: [] },
      topo: ["a"],
      onEvaluate: () => {
        if (fail) throw new Error("kv down");
      },
    });
    scheduler.markDirtyMany(["a"]);
    await vi.advanceTimersByTimeAsync(200);

    fail = false;
    scheduler.markDirtyMany(["a"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(evaluated).toEqual(["a", "a"]);
  });

  it("an after-settled hook rejection is contained", async () => {
    const { scheduler, evaluated } = makeScheduler({
      dependents: { a: [] },
      topo: ["a"],
      afterSettled: async () => {
        throw new Error("hook flush failed");
      },
    });
    scheduler.markDirtyMany(["a"]);
    await vi.advanceTimersByTimeAsync(200);

    expect(evaluated).toEqual(["a"]);
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("after-settle"));
  });
});

describe("stop", () => {
  it("joins an in-flight flush before resolving", async () => {
    let releaseEvaluate: () => void = () => {};
    const evaluateGate = new Promise<void>((resolve) => {
      releaseEvaluate = resolve;
    });
    const evaluated: string[] = [];
    const scheduler = new Scheduler(
      () => [],
      () => 0,
      async (id) => {
        evaluated.push(id);
        await evaluateGate;
      },
      () => false,
      logger,
    );

    scheduler.markDirtyMany(["a"]);
    await vi.advanceTimersByTimeAsync(50); // flush starts, blocks in evaluate
    expect(evaluated).toEqual(["a"]);

    let stopResolved = false;
    const stopPromise = scheduler.stop().then(() => {
      stopResolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopResolved).toBe(false); // still joined to the in-flight flush

    releaseEvaluate();
    await stopPromise;
    expect(stopResolved).toBe(true);
  });

  it("marks after stop never schedule a flush", async () => {
    const { scheduler, evaluated } = makeScheduler({ dependents: { a: [] }, topo: ["a"] });
    await scheduler.stop();
    scheduler.markDirtyMany(["a"]);
    scheduler.markDirty("a");
    scheduler.scheduleTerminal();
    await vi.advanceTimersByTimeAsync(500);
    expect(evaluated).toEqual([]);
  });

  it("stopping with a pending timer cancels it without wedging state", async () => {
    const { scheduler, evaluated } = makeScheduler({ dependents: { a: [] }, topo: ["a"] });
    scheduler.markDirtyMany(["a"]); // timer armed, flush not yet started
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(evaluated).toEqual([]);
  });
});

describe("flush leftovers", () => {
  it("reschedules marks that land behind the cursor instead of dropping them", async () => {
    // Topo order puts b before a; evaluating a marks b (simulating an async
    // commit, e.g. a window emit), so the mark lands behind the flush cursor.
    let marked = false;
    const { scheduler, evaluated } = makeScheduler({
      dependents: { a: [], b: [] },
      topo: ["b", "a"],
      onEvaluate: (id, s) => {
        if (id === "a" && !marked) {
          marked = true;
          s.markDirtyMany(["b"]);
        }
      },
    });
    scheduler.markDirtyMany(["a"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(evaluated).toEqual(["a", "b"]);
  });

  it("a genuine cycle terminates via the circuit breaker instead of spinning forever", async () => {
    // a and b each re-dirty the other on every evaluation.
    const { scheduler, evaluated } = makeScheduler({
      dependents: { a: ["b"], b: ["a"] },
      topo: ["a", "b"],
      onEvaluate: (id, s) => s.markDirty(id),
    });
    scheduler.markDirtyMany(["a"]);
    await vi.advanceTimersByTimeAsync(50 * 100);

    const count = evaluated.length;
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("stalled"));
    await vi.advanceTimersByTimeAsync(50 * 100);
    expect(evaluated.length).toBe(count); // no further work once dropped
  });
});

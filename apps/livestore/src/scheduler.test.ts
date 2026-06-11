import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Scheduler } from "./scheduler.js";

const logger = { info: () => {}, warn: vi.fn(), error: () => {} };

// Graph: src -> win -> expr, with win as a barrier (window property).
function makeScheduler(options: {
  dependents: Record<string, string[]>;
  topo: string[];
  barriers?: string[];
  onEvaluate?: (id: string, scheduler: Scheduler) => void;
}) {
  const evaluated: string[] = [];
  const barriers = new Set(options.barriers ?? []);
  const scheduler: Scheduler = new Scheduler(
    (id) => options.dependents[id] ?? [],
    () => options.topo,
    async (id) => {
      evaluated.push(id);
      options.onEvaluate?.(id, scheduler);
    },
    (id) => barriers.has(id),
    logger,
  );
  return { scheduler, evaluated };
}

beforeEach(() => {
  vi.useFakeTimers();
  logger.warn.mockClear();
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

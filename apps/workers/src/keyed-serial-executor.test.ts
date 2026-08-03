import { describe, expect, it, vi } from "vitest";
import { KeyedSerialExecutor } from "./keyed-serial-executor.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("KeyedSerialExecutor", () => {
  it("runs same-key tasks strictly in submission order", async () => {
    const executor = new KeyedSerialExecutor(4);
    const order: number[] = [];
    for (let i = 0; i < 5; i++) {
      void executor.submit("a", async () => {
        // Later tasks sleep less: they'd finish first if the lane ran concurrently.
        await sleep(10 - i * 2);
        order.push(i);
      });
    }
    await executor.drain();
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("runs different keys concurrently", async () => {
    const executor = new KeyedSerialExecutor(4);
    let running = 0;
    let peak = 0;
    for (const key of ["a", "b", "c", "d"]) {
      void executor.submit(key, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(20);
        running -= 1;
      });
    }
    await executor.drain();
    expect(peak).toBe(4);
  });

  it("caps concurrency at the semaphore", async () => {
    const executor = new KeyedSerialExecutor(2);
    let running = 0;
    let peak = 0;
    for (let i = 0; i < 6; i++) {
      void executor.submit(`k${i}`, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(10);
        running -= 1;
      });
    }
    await executor.drain();
    expect(peak).toBe(2);
  });

  it("cleans up lanes once they drain", async () => {
    const executor = new KeyedSerialExecutor(2);
    await executor.submit("a", async () => {});
    await sleep(0); // cleanup runs on a later microtask
    expect(executor.laneCount).toBe(0);
  });

  it("keeps the lane alive after a task throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const executor = new KeyedSerialExecutor(2);
    const order: string[] = [];
    void executor.submit("a", async () => {
      throw new Error("boom");
    });
    void executor.submit("a", async () => {
      order.push("after");
    });
    await executor.drain();
    expect(order).toEqual(["after"]);
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it("rejects invalid concurrency", () => {
    expect(() => new KeyedSerialExecutor(0)).toThrow();
    expect(() => new KeyedSerialExecutor(1.5)).toThrow();
  });
});

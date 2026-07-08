import { afterEach, describe, expect, it, vi } from "vitest";

import { evaluateExpr, prefixPropertyId } from "./expr.js";
import type { LivestoreLogger, Quality, ValueEnvelope } from "../value/types.js";

const env = (value: number | null, quality: Quality = "good", timestamp = 1000): ValueEnvelope => ({
  value,
  quality,
  timestamp,
});

const dep = (id: string, current: ValueEnvelope) => ({ id, current });

describe("evaluateExpr", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefixes property ids for scope symbols", () => {
    expect(prefixPropertyId("ab-cd-ef")).toBe("p_ab_cd_ef");
  });

  it("evaluates with dependency values and propagates worst quality and latest timestamp", () => {
    const result = evaluateExpr("p_a / p_b", [dep("a", env(6, "good", 1000)), dep("b", env(2, "stale", 2000))]);
    expect(result).toEqual({ value: 3, quality: "stale", timestamp: 2000, context: { expr: true } });
  });

  it("returns uncertain when a dependency is missing", () => {
    const result = evaluateExpr("p_a / p_b", [dep("a", env(6)), dep("b", env(null, "bad"))]);
    expect(result.value).toBeNull();
    expect(result.quality).toBe("uncertain");
  });

  it("returns uncertain on divide-by-zero", () => {
    const result = evaluateExpr("p_a / p_b", [dep("a", env(6)), dep("b", env(0))]);
    expect(result.value).toBeNull();
    expect(result.quality).toBe("uncertain");
  });

  it("returns bad with error context for invalid expressions", () => {
    const result = evaluateExpr("a = 2", [dep("a", env(1))]);
    expect(result.value).toBeNull();
    expect(result.quality).toBe("bad");
    expect(result.context?.error).toContain("unsupported syntax");
  });

  it("returns bad and warns when eval exceeds the timeout", () => {
    const logger: LivestoreLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(500);
    const result = evaluateExpr("p_a + p_b", [dep("a", env(1)), dep("b", env(2))], { logger });
    expect(result.value).toBeNull();
    expect(result.quality).toBe("bad");
    expect(result.context?.error).toBe("eval timeout");
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("respects a per-property timeout override", () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(500);
    const result = evaluateExpr("p_a + p_b", [dep("a", env(1)), dep("b", env(2))], { timeoutMs: 1000 });
    expect(result.value).toBe(3);
    expect(result.quality).toBe("good");
  });
});

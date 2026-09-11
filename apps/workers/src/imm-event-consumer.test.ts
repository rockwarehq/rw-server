import { describe, expect, test } from "vitest";
import { isContention } from "./imm-event-consumer.js";

describe("isContention", () => {
  test("recognises an expired or unstartable Prisma transaction", () => {
    expect(isContention({ code: "P2028", message: "Transaction already closed" })).toBe(true);
  });
  test("recognises Postgres lock and statement timeouts", () => {
    expect(isContention({ code: "55P03", message: "canceling statement due to lock timeout" })).toBe(true);
    expect(isContention(new Error("canceling statement due to statement timeout"))).toBe(true);
  });
  test("anything else is a bad event", () => {
    expect(isContention(new Error("boom"))).toBe(false);
    expect(isContention({ code: "P2002" })).toBe(false);
    expect(isContention(null)).toBe(false);
  });
});

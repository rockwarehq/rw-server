import { describe, expect, it } from "vitest";

import { expandExpressionFieldRefs } from "./nodes.js";

const ids = new Map([
  ["totalItems", "11111111-1111-4111-8111-111111111111"],
  ["badItems", "22222222-2222-4222-8222-222222222222"],
]);

const prefixed = (id: string) => `p_${id.replaceAll("-", "_")}`;

describe("expandExpressionFieldRefs", () => {
  it("rewrites $field.<key> tokens to sibling prefixed property ids", () => {
    const result = expandExpressionFieldRefs("$field.totalItems - $field.badItems", ids);
    expect(result).toBe(`${prefixed(ids.get("totalItems")!)} - ${prefixed(ids.get("badItems")!)}`);
  });

  it("rewrites repeated references to the same field", () => {
    const result = expandExpressionFieldRefs("($field.totalItems - $field.badItems) / $field.totalItems", ids);
    const total = prefixed(ids.get("totalItems")!);
    const bad = prefixed(ids.get("badItems")!);
    expect(result).toBe(`(${total} - ${bad}) / ${total}`);
  });

  it("errors on an unknown sibling field", () => {
    const result = expandExpressionFieldRefs("$field.totalItems / $field.unknown", ids);
    expect(result).toMatchObject({ code: "INVALID_RESOLVER" });
    expect((result as { error: string }).error).toContain("unknown");
  });

  it("leaves an expression with no field refs unchanged", () => {
    expect(expandExpressionFieldRefs("1 + 2", ids)).toBe("1 + 2");
  });
});

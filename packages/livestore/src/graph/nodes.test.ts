import { describe, expect, it } from "vitest";

import {
  buildRequestedProperties,
  expandExpressionFieldRefs,
  missingTypeFieldKeys,
  partitionAddableFields,
} from "./nodes.js";

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

describe("buildRequestedProperties", () => {
  const goodItems = { id: "prop-1", typeFieldKey: "goodItems", name: "goodItems" };
  const oee = { id: "prop-2", typeFieldKey: "oee", name: "oee" };
  const customNamed = { id: "prop-3", typeFieldKey: null, name: "Scrap Rate" };
  const properties = [goodItems, oee, customNamed];

  it("matches camelCase typeFieldKeys against normalized (lowercased) request keys", () => {
    const result = buildRequestedProperties([{ original: "goodItems", normalized: "gooditems" }], properties);
    expect(result.goodItems).toBe(goodItems);
  });

  it("keys the response by the caller's original spelling", () => {
    const result = buildRequestedProperties(
      [
        { original: "goodItems", normalized: "gooditems" },
        { original: "oee", normalized: "oee" },
      ],
      properties,
    );
    expect(Object.keys(result)).toEqual(["goodItems", "oee"]);
    expect(result.oee).toBe(oee);
  });

  it("matches user-named properties by folded name", () => {
    const result = buildRequestedProperties([{ original: "scrap rate", normalized: "scrap_rate" }], properties);
    expect(result["scrap rate"]).toBe(customNamed);
  });

  it("returns null for keys with no matching property", () => {
    const result = buildRequestedProperties([{ original: "statusReason", normalized: "statusreason" }], properties);
    expect(result.statusReason).toBeNull();
  });
});

describe("missingTypeFieldKeys", () => {
  it("lists only the type fields a node has no property for", () => {
    expect(missingTypeFieldKeys(["oee", "currentSpeed", "standardSpeed"], ["oee", "actualFPM"])).toEqual([
      "currentSpeed",
      "standardSpeed",
    ]);
  });

  it("treats a deleted property's name as taken, so a removed field stays removed", () => {
    // Names come from every property row, deleted or not.
    expect(missingTypeFieldKeys(["oee", "currentSpeed"], ["oee", "currentSpeed"])).toEqual([]);
  });

  it("adds nothing when the node is up to date", () => {
    expect(missingTypeFieldKeys([], ["oee"])).toEqual([]);
  });
});

describe("partitionAddableFields", () => {
  it("holds back a field that depends on a deleted property", () => {
    const ok = { name: "currentSpeed", dependencyIds: [] };
    const ratio = { name: "speedRatio", dependencyIds: ["live-1", "deleted-1"] };
    const { addable, blocked } = partitionAddableFields([ok, ratio], new Set(["deleted-1"]));
    expect(addable).toEqual([ok]);
    expect(blocked).toEqual([ratio]);
  });
});

import { describe, expect, it } from "vitest";
import { isValidHookContextFieldName, parseGraphHookEventContext } from "./hook-conditions.js";

const propertySource = { type: "property", propertyId: "prop-1" };

describe("parseGraphHookEventContext", () => {
  it("parses a catalog-style binding with no declared type", () => {
    expect(parseGraphHookEventContext({ stationId: { source: propertySource } })).toEqual({
      stationId: { source: { type: "property", propertyId: "prop-1" } },
    });
  });

  it("keeps an author-declared valueType and required flag", () => {
    const context = parseGraphHookEventContext({
      partCount: { source: propertySource, valueType: "number", required: false },
    });

    expect(context).toEqual({
      partCount: { source: { type: "property", propertyId: "prop-1" }, valueType: "number", required: false },
    });
  });

  it("rejects an unknown valueType", () => {
    expect(parseGraphHookEventContext({ partCount: { source: propertySource, valueType: "date" } })).toBeNull();
  });

  it("rejects a non-boolean required flag", () => {
    expect(parseGraphHookEventContext({ partCount: { source: propertySource, required: "yes" } })).toBeNull();
  });

  it("rejects a binding without a property source", () => {
    expect(parseGraphHookEventContext({ partCount: { source: { type: "literal", value: 1 } } })).toBeNull();
  });

  it("treats undefined as an empty context", () => {
    expect(parseGraphHookEventContext(undefined)).toEqual({});
  });
});

describe("isValidHookContextFieldName", () => {
  it("accepts identifier-shaped names", () => {
    expect(isValidHookContextFieldName("partCount")).toBe(true);
    expect(isValidHookContextFieldName("_internal")).toBe(true);
    expect(isValidHookContextFieldName("Machine_2")).toBe(true);
  });

  it("rejects names that would not survive as a payload key or SQL parameter", () => {
    expect(isValidHookContextFieldName("2ndCount")).toBe(false);
    expect(isValidHookContextFieldName("part count")).toBe(false);
    expect(isValidHookContextFieldName("part-count")).toBe(false);
    expect(isValidHookContextFieldName("drop; --")).toBe(false);
    expect(isValidHookContextFieldName("")).toBe(false);
    expect(isValidHookContextFieldName("a".repeat(65))).toBe(false);
  });
});

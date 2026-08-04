import { describe, expect, it } from "vitest";
import { resolveInputTemplate, templateFieldNames } from "./template.js";

const payload = { stationId: "station-1", cycleTime: 12.5, running: true, missing: null };

describe("resolveInputTemplate", () => {
  it("preserves value types instead of stringifying them", () => {
    const result = resolveInputTemplate(
      {
        procedure: "dbo.RecordCycle",
        parameters: [
          { name: "StationId", type: "uniqueidentifier", value: { $from: "stationId" } },
          { name: "CycleTime", type: "float", value: { $from: "cycleTime" } },
          { name: "Running", type: "bit", value: { $from: "running" } },
        ],
      },
      payload,
    );

    expect(result).toEqual({
      data: {
        procedure: "dbo.RecordCycle",
        parameters: [
          { name: "StationId", type: "uniqueidentifier", value: "station-1" },
          { name: "CycleTime", type: "float", value: 12.5 },
          { name: "Running", type: "bit", value: true },
        ],
      },
    });
  });

  it("leaves literals untouched", () => {
    expect(resolveInputTemplate({ name: "Source", value: "rockware", count: 3 }, payload)).toEqual({
      data: { name: "Source", value: "rockware", count: 3 },
    });
  });

  it("resolves a present null field rather than falling back", () => {
    expect(resolveInputTemplate({ value: { $from: "missing", $default: "fallback" } }, payload)).toEqual({
      data: { value: null },
    });
  });

  it("uses $default when the field is absent", () => {
    expect(resolveInputTemplate({ value: { $from: "partCount", $default: 0 } }, payload)).toEqual({
      data: { value: 0 },
    });
  });

  it("fails on an absent field with no default", () => {
    expect(resolveInputTemplate({ value: { $from: "partCount" } }, payload)).toMatchObject({
      code: "TEMPLATE_FIELD_MISSING",
    });
  });

  it("resolves bindings nested in arrays and objects", () => {
    expect(resolveInputTemplate({ a: [{ b: { c: { $from: "cycleTime" } } }] }, payload)).toEqual({
      data: { a: [{ b: { c: 12.5 } }] },
    });
  });

  it("rejects a pathologically nested template", () => {
    let deep: unknown = { $from: "cycleTime" };
    for (let i = 0; i < 25; i += 1) deep = { nested: deep };
    expect(resolveInputTemplate(deep, payload)).toMatchObject({ code: "TEMPLATE_FIELD_MISSING" });
  });
});

describe("templateFieldNames", () => {
  it("lists every payload field a template reads", () => {
    const fields = templateFieldNames({
      parameters: [
        { value: { $from: "stationId" } },
        { value: { $from: "cycleTime" } },
        { value: "literal" },
        { value: { $from: "stationId" } },
      ],
    });

    expect(fields.sort()).toEqual(["cycleTime", "stationId"]);
  });

  it("returns nothing for a template with no bindings", () => {
    expect(templateFieldNames({ procedure: "dbo.Ping", parameters: [] })).toEqual([]);
  });
});

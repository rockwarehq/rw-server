import sql from "mssql";
import { describe, expect, it } from "vitest";
import { coerceParameterValue, sqlTypeFor, SQL_PARAMETER_TYPES } from "./sqlserver.js";

describe("sql parameter types", () => {
  it("maps every declared type to an mssql type", () => {
    for (const type of SQL_PARAMETER_TYPES) {
      expect(sqlTypeFor(type)).toBeDefined();
    }
  });

  it("maps string to a max-length nvarchar", () => {
    expect(sqlTypeFor("string")).toMatchObject({ type: sql.NVarChar().type, length: sql.MAX });
  });
});

describe("parameter coercion", () => {
  const parameter = (type: (typeof SQL_PARAMETER_TYPES)[number], value: unknown) =>
    ({ name: "p", type, value, output: false }) as Parameters<typeof coerceParameterValue>[0];

  it("passes null through for any type", () => {
    for (const type of SQL_PARAMETER_TYPES) {
      expect(coerceParameterValue(parameter(type, null))).toBeNull();
    }
  });

  it("converts an ISO string to a Date", () => {
    const value = coerceParameterValue(parameter("datetime", "2026-07-28T12:00:00.000Z"));
    expect(value).toBeInstanceOf(Date);
    expect((value as Date).toISOString()).toBe("2026-07-28T12:00:00.000Z");
  });

  it("converts an epoch number to a Date", () => {
    const value = coerceParameterValue(parameter("datetime", 1_774_699_200_000));
    expect(value).toBeInstanceOf(Date);
  });

  it("rejects an unparseable datetime rather than sending an invalid date", () => {
    expect(() => coerceParameterValue(parameter("datetime", "not a date"))).toThrow(/not a valid datetime/);
  });

  it("coerces numeric strings for numeric types", () => {
    expect(coerceParameterValue(parameter("int", "42"))).toBe(42);
    expect(coerceParameterValue(parameter("float", "1.5"))).toBe(1.5);
  });

  it("rejects a non-numeric value for a numeric type", () => {
    expect(() => coerceParameterValue(parameter("int", "abc"))).toThrow(/not a valid number/);
  });

  it("coerces to boolean for bit", () => {
    expect(coerceParameterValue(parameter("bit", true))).toBe(true);
    expect(coerceParameterValue(parameter("bit", 0))).toBe(false);
  });

  it("stringifies for string and uniqueidentifier", () => {
    expect(coerceParameterValue(parameter("string", 42))).toBe("42");
    expect(coerceParameterValue(parameter("uniqueidentifier", "0f7a…"))).toBe("0f7a…");
  });
});

import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/setup/csv.js";

// The setup upload reader: what spreadsheet exports actually look like.

describe("parseCsv", () => {
  it("reads quotes, doubled quotes, line breaks inside quotes, CRLF and a BOM", () => {
    const table = parseCsv('﻿Key,Name,Note\r\nA1,"Cap, 38mm","say ""hi""\nthere"\r\n\r\nA2,Lid,\r\n');
    expect(table.headers).toEqual(["Key", "Name", "Note"]);
    expect(table.rows).toEqual([
      { line: 2, cells: ["A1", "Cap, 38mm", 'say "hi"\nthere'] },
      { line: 5, cells: ["A2", "Lid", ""] },
    ]);
  });

  it("uses the delimiter the header uses", () => {
    expect(parseCsv("a;b;c\n1;2,5;3").rows[0]?.cells).toEqual(["1", "2,5", "3"]);
    expect(parseCsv("a\tb\n1\t2").rows[0]?.cells).toEqual(["1", "2"]);
    expect(parseCsv("only\nx").rows[0]?.cells).toEqual(["x"]);
  });

  it("keeps a last line without a line break", () => {
    expect(parseCsv("a,b\n1,2").rows).toEqual([{ line: 2, cells: ["1", "2"] }]);
  });
});

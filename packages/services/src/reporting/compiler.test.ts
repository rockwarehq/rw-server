import { describe, expect, it } from "vitest";
import { compileReportQuery, compileReportRows } from "./compiler.js";
import { FACTS } from "./facts.js";
import { reportSchema } from "./index.js";
import type { ReportQuery, ReportRowsQuery, ReportScope } from "./types.js";

const SITE = "11111111-1111-4111-8111-111111111111";
const WORKCENTER = "22222222-2222-4222-8222-222222222222";
const STATION = "33333333-3333-4333-8333-333333333333";

const scope: ReportScope = { siteId: SITE };
const restricted: ReportScope = { siteId: SITE, workcenterIds: [WORKCENTER] };

/** Compiled text with `?` placeholders and whitespace collapsed. */
const flat = (sql: { sql: string }) => sql.sql.replace(/\s+/g, " ").trim();

function agg(query: ReportQuery, s: ReportScope = scope) {
  const result = compileReportQuery(query, s);
  if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
  return { text: flat(result), values: result.values };
}

function rows(query: ReportRowsQuery, s: ReportScope = scope) {
  const result = compileReportRows(query, s);
  if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
  return { text: flat(result.sql), count: flat(result.count), values: result.sql.values };
}

/** Errors are returned, never thrown — the rpc layer maps them to 4xx. */
function failure(result: unknown): { error: string; code: string } {
  if (!result || typeof result !== "object" || !("error" in result)) {
    throw new Error("expected a ServiceError");
  }
  return result as { error: string; code: string };
}

describe("detail rows — projection", () => {
  it("projects columns in the order asked for, with no grouping", () => {
    const { text } = rows({ fact: "cycles", columns: ["station", "start", "end"] });
    expect(text).not.toContain("GROUP BY");
    expect(text.indexOf('AS "station"')).toBeLessThan(text.indexOf('AS "start"'));
    expect(text.indexOf('AS "start"')).toBeLessThan(text.indexOf('AS "end"'));
  });

  it("renders timestamps as UTC ISO strings, so the wire stays string|number|null", () => {
    const { text } = rows({ fact: "cycles", columns: ["start"] });
    expect(text).toContain(`to_char(f."start" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "start"`);
  });

  it("renders decimals as exact text, not float8", () => {
    const { text } = rows({ fact: "cycles", columns: ["quantity"] });
    expect(text).toContain(`f."quantity"::text AS "quantity"`);
  });

  it("prefers the field over a measure of the same name, keeping the value lossless", () => {
    // `cycles` declares both a `quantity` measure (SUM) and a `quantity` field.
    const { text } = rows({ fact: "cycles", columns: ["quantity"] });
    expect(text).not.toContain("SUM(");
  });

  it("carries an id dimension's display name alongside it", () => {
    const { text } = rows({ fact: "cycles", columns: ["station"] });
    expect(text).toContain('LEFT JOIN "Station" d0');
    expect(text).toContain('AS "stationName"');
  });

  it("keeps businessDate a business-calendar string", () => {
    const { text } = rows({ fact: "cycles", columns: ["businessDate"] });
    expect(text).toContain(`to_char(f."businessDate", 'YYYY-MM-DD') AS "businessDate"`);
  });

  it("unwraps a measure to its row-local expression", () => {
    const { text } = rows({ fact: "statePeriods", columns: ["durationSeconds"] });
    expect(text).toContain('AS "durationSeconds"');
    expect(text).not.toContain("SUM(");
  });

  it("unwraps an avg measure too — per row it is that row's own value", () => {
    const { text } = rows({ fact: "cycles", columns: ["avgCycleSeconds"] });
    expect(text).not.toContain("AVG(");
  });

  it("evaluates a ratio measure per row", () => {
    const { text } = rows({ fact: "stationKpis", columns: ["oee"] });
    expect(text).toContain("NULLIF(");
    expect(text).not.toContain("SUM(");
  });

  it("refuses a count measure, which has no per-row value", () => {
    const result = failure(compileReportRows({ fact: "cycles", columns: ["cycles"] }, scope));
    expect(result.code).toBe("INVALID_MEASURE");
  });

  it("refuses an unknown column", () => {
    const result = failure(compileReportRows({ fact: "cycles", columns: ["nope"] }, scope));
    expect(result.code).toBe("UNKNOWN_COLUMN");
  });

  it("requires at least one column", () => {
    const result = failure(compileReportRows({ fact: "cycles", columns: [] }, scope));
    expect(result.code).toBe("INVALID_QUERY");
  });
});

describe("detail rows — ordering and paging", () => {
  it("always ends ORDER BY with the row key, so OFFSET paging is stable", () => {
    const { text } = rows({ fact: "cycles", columns: ["start"] });
    expect(text).toMatch(/ORDER BY .*f\."id" DESC LIMIT/);
  });

  it("defaults to the fact's event timestamp, newest first", () => {
    const { text } = rows({ fact: "cycles", columns: ["start"] });
    expect(text).toContain(`ORDER BY f."end" DESC NULLS LAST, f."id" DESC`);
  });

  it("orders by the underlying column, not the rendered alias", () => {
    const { text } = rows({ fact: "cycles", columns: ["start"], orderBy: { field: "start", dir: "asc" } });
    expect(text).toContain(`ORDER BY f."start" ASC NULLS LAST, f."id" DESC`);
  });

  it("refuses an orderBy that is not a selected column", () => {
    const result = failure(
      compileReportRows({ fact: "cycles", columns: ["start"], orderBy: { field: "end", dir: "asc" } }, scope),
    );
    expect(result.code).toBe("INVALID_QUERY");
  });

  it("asks for one row beyond the limit, to detect truncation", () => {
    const { text } = rows({ fact: "cycles", columns: ["start"], limit: 50 });
    expect(text).toContain("LIMIT ? OFFSET ?");
    const { values } = rows({ fact: "cycles", columns: ["start"], limit: 50 });
    expect(values).toContain(51);
  });

  it("counts with the same predicate but without the display joins", () => {
    const { count } = rows({ fact: "cycles", columns: ["station"] });
    expect(count).toContain('COUNT(*)::bigint AS "total"');
    expect(count).not.toContain("LEFT JOIN");
    expect(count).toContain('f."siteId" = ?');
  });
});

describe("grain rules split by mode", () => {
  it("totals only completed cycles", () => {
    const { text } = agg({ fact: "cycles", measures: ["cycles"], dimensions: [] });
    expect(text).toContain(`f."end" IS NOT NULL`);
  });

  it("lists the cycle that is still running", () => {
    const { text } = rows({ fact: "cycles", columns: ["start", "end"] });
    expect(text).not.toContain(`f."end" IS NOT NULL`);
  });

  it("applies the soft-delete filter in both modes", () => {
    expect(agg({ fact: "cycles", measures: ["cycles"], dimensions: [] }).text).toContain(`f."deletedAt" IS NULL`);
    expect(rows({ fact: "cycles", columns: ["start"] }).text).toContain(`f."deletedAt" IS NULL`);
  });
});

describe("predicates shared by both modes", () => {
  it("scopes to the site in both modes", () => {
    expect(agg({ fact: "cycles", measures: ["cycles"], dimensions: [] }).values).toContain(SITE);
    expect(rows({ fact: "cycles", columns: ["start"] }).values).toContain(SITE);
  });

  it("narrows detail rows to granted workcenters, strictly", () => {
    const { text, values } = rows({ fact: "cycles", columns: ["start"] }, restricted);
    expect(text).toContain(`f."workcenterId" = ANY(?`);
    expect(values).toContainEqual([WORKCENTER]);
  });

  it("narrows every KPI fact through the bucket path, job buckets included", () => {
    // Job bucket entityIds are opaque hashes, but the hierarchy path carries
    // the workcenter for all three entity types, so none of them has to refuse.
    for (const fact of ["stationKpis", "workcenterKpis", "jobKpis"]) {
      const { text, values } = rows({ fact, columns: ["totalCycles"] }, restricted);
      expect(text).toContain(`substring(f."path" from 'workcenter\\.([0-9a-f-]{36})')::uuid = ANY(?`);
      expect(values).toContainEqual([WORKCENTER]);
    }
  });

  it("still refuses a fact with no workcenter linkage at all", () => {
    // Site-level facts (a stock correction has no station) cannot be narrowed.
    const result = failure(compileReportRows({ fact: "stockAdjustments", columns: ["id"] }, restricted));
    expect(result.code).toBe("WORKCENTER_RESTRICTED");
  });

  it("binds filter values as parameters, never as SQL", () => {
    const { text, values } = rows({
      fact: "cycles",
      columns: ["start"],
      filters: [{ dimension: "station", op: "eq", value: STATION }],
    });
    expect(text).not.toContain(STATION);
    expect(values).toContain(STATION);
  });

  it("rejects a malformed id filter instead of letting Postgres 500", () => {
    const result = failure(
      compileReportRows(
        { fact: "cycles", columns: ["start"], filters: [{ dimension: "station", op: "eq", value: "not-a-uuid" }] },
        scope,
      ),
    );
    expect(result.code).toBe("INVALID_FILTER");
  });
});

describe("fact default filters", () => {
  it("hides unscheduled time in detail mode too (ADR-0015)", () => {
    const { values } = rows({ fact: "cycles", columns: ["start"] });
    expect(values).toContain("true");
  });

  it("stands down when the query pins the dimension itself", () => {
    const { values } = rows({
      fact: "cycles",
      columns: ["start"],
      filters: [{ dimension: "scheduled", op: "eq", value: "false" }],
    });
    expect(values).toContain("false");
    expect(values).not.toContain("true");
  });

  it("still applies when the dimension is merely selected — detail sums nothing, so selecting is not a claim about scope", () => {
    const { values } = rows({ fact: "cycles", columns: ["scheduled"] });
    expect(values).toContain("true");
  });

  it("stands down in aggregate mode when the dimension is grouped", () => {
    const { values } = agg({ fact: "cycles", measures: ["cycles"], dimensions: ["scheduled"] });
    expect(values).not.toContain("true");
  });
});

describe("comparison operators", () => {
  it("compares a date dimension with a range", () => {
    const { text, values } = rows({
      fact: "cycles",
      columns: ["businessDate"],
      filters: [{ dimension: "businessDate", op: "between", value: ["2026-09-01", "2026-09-30"] }],
    });
    expect(text).toContain(`f."businessDate" BETWEEN ?::date AND ?::date`);
    expect(values).toContain("2026-09-01");
  });

  it("compares a timestamp field with an instant", () => {
    const { text } = rows({
      fact: "cycles",
      columns: ["start"],
      filters: [{ dimension: "start", op: "gte", value: "2026-09-17T06:00:00Z" }],
    });
    expect(text).toContain(`f."start" >= ?::timestamptz`);
  });

  it("finds the rows still running, via a null check", () => {
    const { text } = rows({
      fact: "cycles",
      columns: ["id", "start"],
      filters: [{ dimension: "end", op: "isNull" }],
    });
    expect(text).toContain(`f."end" IS NULL`);
  });

  it("matches text case-insensitively", () => {
    const { text, values } = rows({
      fact: "statePeriods",
      columns: ["id"],
      filters: [{ dimension: "blockId", op: "contains", value: "abc" }],
    });
    expect(text).toContain("ILIKE ?");
    expect(values).toContain("%abc%");
  });

  it("treats a wildcard in the user's value as literal text", () => {
    const { values } = rows({
      fact: "statePeriods",
      columns: ["id"],
      filters: [{ dimension: "blockId", op: "beginsWith", value: "50%_x" }],
    });
    expect(values).toContain("50\\%\\_x%");
  });

  it("excludes a set of ids", () => {
    const { text } = rows({
      fact: "cycles",
      columns: ["id"],
      filters: [{ dimension: "station", op: "notIn", value: [STATION] }],
    });
    expect(text).toContain(`NOT (f."stationId" = ANY(?::uuid[]))`);
  });

  it("treats neq as also matching rows with no value at all", () => {
    const { text } = rows({
      fact: "cycles",
      columns: ["id"],
      filters: [{ dimension: "station", op: "neq", value: STATION }],
    });
    expect(text).toContain("IS DISTINCT FROM");
  });

  it("refuses ordering a uuid", () => {
    const result = failure(
      compileReportRows(
        { fact: "cycles", columns: ["id"], filters: [{ dimension: "station", op: "gt", value: STATION }] },
        scope,
      ),
    );
    expect(result.code).toBe("INVALID_FILTER");
  });

  it("refuses substring-matching a date", () => {
    const result = failure(
      compileReportRows(
        { fact: "cycles", columns: ["id"], filters: [{ dimension: "businessDate", op: "contains", value: "09" }] },
        scope,
      ),
    );
    expect(result.code).toBe("INVALID_FILTER");
  });

  it("refuses a range without exactly two values", () => {
    const result = failure(
      compileReportRows(
        {
          fact: "cycles",
          columns: ["id"],
          filters: [{ dimension: "businessDate", op: "between", value: ["2026-09-01"] }],
        },
        scope,
      ),
    );
    expect(result.code).toBe("INVALID_FILTER");
  });

  it("refuses a non-numeric value on a numeric target", () => {
    const result = failure(
      compileReportRows(
        { fact: "cycles", columns: ["id"], filters: [{ dimension: "standardCycle", op: "gt", value: "soon" }] },
        scope,
      ),
    );
    expect(result.code).toBe("INVALID_FILTER");
  });

  it("refuses an unknown filter target", () => {
    const result = failure(
      compileReportRows(
        { fact: "cycles", columns: ["id"], filters: [{ dimension: "nope", op: "eq", value: "x" }] },
        scope,
      ),
    );
    expect(result.code).toBe("UNKNOWN_DIMENSION");
  });
});

describe("measure filters land where the value lives", () => {
  it("filters a total with HAVING", () => {
    const { text } = agg({
      fact: "dispositions",
      measures: ["quantity"],
      dimensions: ["station"],
      filters: [{ dimension: "quantity", op: "gt", value: "100" }],
    });
    expect(text).toMatch(/GROUP BY .* HAVING \(\(SUM/);
  });

  it("filters a row's own value with WHERE in detail mode", () => {
    const { text } = rows({
      fact: "statePeriods",
      columns: ["id", "durationSeconds"],
      filters: [{ dimension: "durationSeconds", op: "gt", value: "300" }],
    });
    expect(text).not.toContain("HAVING");
    expect(text).toContain("WHERE");
    expect(text).not.toContain("SUM(");
  });

  it("refuses a count measure as a detail filter — a row has no count", () => {
    const result = failure(
      compileReportRows(
        { fact: "cycles", columns: ["id"], filters: [{ dimension: "cycles", op: "gt", value: "1" }] },
        scope,
      ),
    );
    expect(result.code).toBe("INVALID_MEASURE");
  });

  it("keeps detail-only fields out of aggregate queries entirely", () => {
    expect(
      failure(compileReportQuery({ fact: "cycles", measures: ["cycles"], dimensions: ["start"] }, scope)).code,
    ).toBe("UNKNOWN_DIMENSION");
    expect(
      failure(
        compileReportQuery(
          {
            fact: "cycles",
            measures: ["cycles"],
            dimensions: [],
            filters: [{ dimension: "start", op: "gte", value: "2026-09-01T00:00:00Z" }],
          },
          scope,
        ),
      ).code,
    ).toBe("UNKNOWN_DIMENSION");
  });

  it("filters an aggregate ratio, so a slice can be held to a threshold", () => {
    const { text } = agg({
      fact: "stationKpis",
      measures: ["oee"],
      dimensions: ["station"],
      filters: [{ dimension: "oee", op: "lt", value: "0.5" }],
    });
    expect(text).toContain("HAVING");
    expect(text).toContain("NULLIF(");
  });
});

describe("filtering by name instead of id", () => {
  it("matches a lookup name, joining for the filter even when the column is not selected", () => {
    const { text, values } = rows({
      fact: "statePeriods",
      columns: ["id"],
      filters: [{ dimension: "statusReasonName", op: "contains", value: "mold" }],
    });
    expect(text).toContain('LEFT JOIN "StatusReason" fn0');
    expect(text).toContain('fn0."name"::text ILIKE ?');
    expect(values).toContain("%mold%");
  });

  it("reaches a two-hop name, so downtime can filter by category", () => {
    const { text } = rows({
      fact: "statePeriods",
      columns: ["id"],
      filters: [{ dimension: "statusCategoryName", op: "eq", value: "Maintenance" }],
    });
    expect(text).toContain('LEFT JOIN "StatusCategory" fn0b');
    expect(text).toContain('fn0b."name"::text = ?');
  });

  it("uses a row-local name column with no join at all", () => {
    // jobKpis labels its opaque entityId from the bucket's own entityName.
    const { text } = rows({
      fact: "jobKpis",
      columns: ["jobRun"],
      filters: [{ dimension: "jobRunName", op: "beginsWith", value: "WK0" }],
    });
    expect(text).toContain('f."entityName"::text ILIKE ?');
    expect(text).not.toContain("fn0");
  });

  it("carries the filter join into the count as well", () => {
    const { count } = rows({
      fact: "dispositions",
      columns: ["id"],
      filters: [{ dimension: "reasonName", op: "contains", value: "flash" }],
    });
    expect(count).toContain('LEFT JOIN "ItemDispositionReason" fn0');
  });

  it("works in aggregate mode", () => {
    const { text } = agg({
      fact: "dispositions",
      measures: ["quantity"],
      dimensions: ["station"],
      filters: [{ dimension: "reasonName", op: "contains", value: "flash" }],
    });
    expect(text).toContain("ILIKE ?");
  });
});

describe("dimensions backed by an expression", () => {
  it("groups and projects the workcenter pulled out of a bucket path", () => {
    const { text } = agg({ fact: "stationKpis", measures: ["oee"], dimensions: ["workcenter"] });
    expect(text).toContain(`substring(f."path" from 'workcenter\\.([0-9a-f-]{36})')::uuid AS "workcenter"`);
    expect(text).toContain('LEFT JOIN "Workcenter" d0');
    expect(text).toContain('AS "workcenterName"');
  });

  it("filters on the expression, not a column", () => {
    const { text, values } = rows({
      fact: "stationKpis",
      columns: ["station"],
      filters: [{ dimension: "workcenter", op: "eq", value: WORKCENTER }],
    });
    expect(text).toContain(`substring(f."path" from 'workcenter\\.([0-9a-f-]{36})')::uuid = ?::uuid`);
    expect(values).toContain(WORKCENTER);
  });
});

describe("aggregate page counts", () => {
  it("counts groups, not rows, by counting the grouped set", () => {
    const compiled = compileReportQuery({ fact: "cycles", measures: ["cycles"], dimensions: ["station"] }, scope);
    if ("error" in compiled) throw new Error(compiled.error);
    // compileReportQuery hands back the page; runReportQuery pairs it with the
    // count, which wraps the same grouping in a subquery.
    expect(flat(compiled)).toContain("GROUP BY");
  });

  it("is off unless asked for", () => {
    // includeTotal defaults off: a chart or export pays nothing for a count.
    const q: ReportQuery = { fact: "cycles", measures: ["cycles"], dimensions: [] };
    expect(q.includeTotal).toBeUndefined();
  });
});

describe("columns restored to match the old log pages", () => {
  const cases: [string, string][] = [
    ["dispositions", "productSku"],
    ["dispositions", "toolCavity"],
    ["statePeriods", "statusCategory"],
    ["logonSessions", "employeeNumber"],
    ["logonSessions", "display"],
    ["stationKpis", "workcenter"],
    ["jobKpis", "workcenter"],
  ];

  for (const [fact, dimension] of cases) {
    it(`${fact} can group by ${dimension}`, () => {
      const measure = Object.entries(FACTS[fact].measures).find(([, m]) => m.kind !== "ratio")?.[0];
      const { text } = agg({ fact, measures: [measure as string], dimensions: [dimension] });
      expect(text).toContain(`AS "${dimension}"`);
      expect(text).toContain(`AS "${dimension}Name"`);
    });
  }
});

describe("the schema cannot promise more than the compiler accepts", () => {
  it("marks exactly the measures a detail row can show", () => {
    for (const fact of reportSchema()) {
      if (!fact.supportsDetail) continue;
      for (const measure of fact.measures) {
        const compiled = compileReportRows({ fact: fact.key, columns: [measure.key] }, scope);
        const accepted = !("error" in compiled);
        expect(
          accepted,
          `${fact.key}.${measure.key}: schema says rowLocal=${measure.rowLocal}, compiler ${
            accepted ? "accepted" : "refused"
          } it`,
        ).toBe(measure.rowLocal);
      }
    }
  });

  it("lists only columns a detail query can actually request", () => {
    for (const fact of reportSchema()) {
      if (!fact.supportsDetail) continue;
      const columns = [
        ...fact.dimensions.map((d) => d.key),
        ...fact.fields.map((f) => f.key),
        ...fact.measures.filter((m) => m.rowLocal).map((m) => m.key),
      ];
      const compiled = compileReportRows({ fact: fact.key, columns }, scope);
      expect("error" in compiled ? compiled.error : "ok", `fact ${fact.key}`).toBe("ok");
    }
  });
});

describe("every value says how to render itself", () => {
  it("gives seconds and percentages their own format, not a bare count", () => {
    const formats = new Map<string, string>();
    for (const fact of reportSchema()) {
      for (const measure of fact.measures) formats.set(`${fact.key}.${measure.key}`, measure.format);
      for (const field of fact.fields) formats.set(`${fact.key}.${field.key}`, field.format);
    }
    // A duration rendered as "15163.51" and a rate rendered as "0.235" are the
    // two ways this goes wrong, so pin the representative cases.
    expect(formats.get("statePeriods.durationSeconds")).toBe("seconds");
    expect(formats.get("cycles.standardCycle")).toBe("seconds");
    expect(formats.get("stationKpis.runSeconds")).toBe("seconds");
    expect(formats.get("stationKpis.oee")).toBe("percent");
    expect(formats.get("production.scrapRate")).toBe("percent");
    // A ratio in seconds is why this can't be derived from `kind`.
    expect(formats.get("stationKpis.avgCycleSeconds")).toBe("seconds");
    expect(formats.get("production.produced")).toBe("quantity");
  });

  it("names a format for every measure and field, so no client has to guess", () => {
    const allowed = new Set(["seconds", "percent", "quantity", "count", "text"]);
    for (const fact of reportSchema()) {
      for (const measure of fact.measures) {
        expect(allowed.has(measure.format), `${fact.key}.${measure.key}`).toBe(true);
      }
      for (const field of fact.fields) {
        expect(allowed.has(field.format), `${fact.key}.${field.key}`).toBe(true);
      }
    }
  });
});

describe("label filters", () => {
  const LABEL = "44444444-4444-4444-8444-444444444444";

  it("matches rows whose entity carries one of the labels", () => {
    const { text, values } = rows({
      fact: "statePeriods",
      columns: ["id"],
      filters: [{ dimension: "statusReason", op: "hasLabel", value: [LABEL] }],
    });
    expect(text).toContain(
      `EXISTS (SELECT 1 FROM "_LabelToStatusReason" lbl WHERE lbl."B" = f."statusReasonId" AND lbl."A" = ANY(?::uuid[]))`,
    );
    expect(values).toContainEqual([LABEL]);
  });

  it("puts the entity id in the other column when the label side flips", () => {
    // Prisma names _JobToLabel with the label in B, unlike _LabelToStation.
    const { text } = rows({
      fact: "cycles",
      columns: ["id"],
      filters: [{ dimension: "job", op: "hasLabel", value: [LABEL] }],
    });
    expect(text).toContain(`lbl."A" = f."jobId" AND lbl."B" = ANY(?::uuid[])`);
  });

  it("excludes labelled rows with notHasLabel", () => {
    const { text } = rows({
      fact: "dispositions",
      columns: ["id"],
      filters: [{ dimension: "reason", op: "notHasLabel", value: [LABEL] }],
    });
    expect(text).toContain("NOT EXISTS (");
  });

  it("works in aggregate mode too", () => {
    const { text } = agg({
      fact: "statePeriods",
      measures: ["downSeconds"],
      dimensions: ["station"],
      filters: [{ dimension: "statusReason", op: "hasLabel", value: [LABEL] }],
    });
    expect(text).toContain("EXISTS (");
    expect(text).not.toContain("HAVING");
  });

  it("refuses a label filter on a dimension whose entity has no labels", () => {
    const result = failure(
      compileReportRows(
        { fact: "cycles", columns: ["id"], filters: [{ dimension: "shift", op: "hasLabel", value: [LABEL] }] },
        scope,
      ),
    );
    expect(result.code).toBe("INVALID_FILTER");
  });

  it("rejects a label id that is not a uuid", () => {
    const result = failure(
      compileReportRows(
        { fact: "cycles", columns: ["id"], filters: [{ dimension: "job", op: "hasLabel", value: ["nope"] }] },
        scope,
      ),
    );
    expect(result.code).toBe("INVALID_FILTER");
  });
});

describe("enum projection", () => {
  it("renders an enum dimension as text so a boolean column cannot leak", () => {
    // `scheduled` sits on the isScheduled BOOLEAN column; a raw boolean would
    // break the string|number|null contract every ReportRow value promises.
    expect(agg({ fact: "cycles", measures: ["cycles"], dimensions: ["scheduled"] }).text).toContain(
      `f."isScheduled"::text AS "scheduled"`,
    );
    expect(rows({ fact: "cycles", columns: ["scheduled"] }).text).toContain(`f."isScheduled"::text AS "scheduled"`);
  });
});

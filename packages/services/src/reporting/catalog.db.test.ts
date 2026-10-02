import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runReportQuery, runReportRows, runReportSummary } from "./compiler.js";
import { FACTS } from "./facts.js";
import { type ReportScope, type ReportSummaryItem, SUMMARY_AGGS } from "./types.js";

// Integration: every piece of the catalog's SQL, run against Postgres. The
// compiler tests read the SQL as text; this proves Postgres accepts it —
// every measure, every dimension (with its lookup join or expression), every
// detail field, and both scopes. An empty site is enough: a query that
// compiles and runs over no rows is the claim. Requires DATABASE_URL.

const scopes: [string, ReportScope][] = [
  ["a site", { siteId: randomUUID() }],
  ["granted workcenters", { siteId: randomUUID(), workcenterIds: [randomUUID()] }],
];

const ok = (result: { rows: unknown[] } | { error: string; code: string }) => {
  if ("error" in result) throw new Error(`${result.code}: ${result.error}`);
  return result;
};

describe.skipIf(!process.env.DATABASE_URL)("the report catalog runs on Postgres", () => {
  for (const [key, fact] of Object.entries(FACTS)) {
    const restricted = fact.workcenterColumn === null && !fact.workcenterPredicate;

    it(`${key}: every measure, and each dimension`, async () => {
      for (const [label, scope] of scopes) {
        if (restricted && scope.workcenterIds) continue;
        const measures = Object.keys(fact.measures);
        expect(ok(await runReportQuery({ fact: key, measures, dimensions: [] }, scope)).rows, label).toBeDefined();
        for (const dimension of Object.keys(fact.dimensions)) {
          const result = await runReportQuery({ fact: key, measures: [measures[0]!], dimensions: [dimension] }, scope);
          expect(ok(result).rows, `${label} by ${dimension}`).toEqual([]);
        }
      }
    });

    if (fact.rowKey) {
      it(`${key}: every field and dimension as a row list`, async () => {
        const columns = [...Object.keys(fact.fields ?? {}), ...Object.keys(fact.dimensions)];
        for (const [label, scope] of scopes) {
          if (restricted && scope.workcenterIds) continue;
          expect(ok(await runReportRows({ fact: key, columns, limit: 10 }, scope)).rows, label).toEqual([]);
        }
      });
    }
  }

  // Every figure a log could ask for: each agg over each numeric field and
  // each measure. What the compiler refuses (summing a ratio) is not SQL.
  for (const [key, fact] of Object.entries(FACTS)) {
    if (!fact.rowKey) continue;
    const restricted = fact.workcenterColumn === null && !fact.workcenterPredicate;

    it(`${key}: every summary figure`, async () => {
      const numeric = Object.entries(fact.fields ?? {})
        .filter(([, field]) => field.type === "number" || field.type === "decimal")
        .map(([field]) => field);
      const keys = [...new Set([...numeric, ...Object.keys(fact.measures)])];
      const candidates: ReportSummaryItem[] = [
        { agg: "count" },
        ...keys.flatMap((column) => SUMMARY_AGGS.map((agg) => ({ key: column, agg }))),
      ];
      for (const [, scope] of scopes) {
        if (restricted && scope.workcenterIds) continue;
        let ran = 0;
        for (const item of candidates) {
          const result = await runReportSummary({ fact: key, items: [item] }, scope);
          // A refusal is the compiler's own; anything Postgres rejects throws.
          if ("error" in result) continue;
          expect(result.values).toHaveLength(1);
          ran++;
        }
        expect(ran).toBeGreaterThan(0);
      }
    });
  }
});

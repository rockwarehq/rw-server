import prisma, { Prisma } from "@rw/db";

import type { SetupOrigin } from "./mapping.js";
import type { SetupAction, SetupEntityKind, SetupIssue, SetupOriginRef, SetupPlan, SetupRow } from "./plan.js";

// A changeset's plan lives in two places: the totals and spec-level issues on
// the changeset (planResult, summary), and one SetupChangesetRow per planned
// row. A 20,000-row plan is ~15 MB as one JSON value; as rows it can be paged
// and filtered for review, and only apply reads it whole.

type Db = Prisma.TransactionClient;

const ROW_BATCH = 1000;

export function summarize(plan: SetupPlan) {
  return { ...plan.summary, applicable: plan.applicable, issues: plan.issues.length };
}

/** What a changeset keeps about its files: where rows came from, and values that couldn't be read. */
export type StoredOrigin = SetupOrigin & { issues: SetupIssue[] };

/**
 * A plan of a file-built spec, as a person reviews it: rows point at their
 * file lines, and values the files had that couldn't be read stay as issues
 * on every replan (the spec left those fields out, so the planner alone
 * would call the rows fine).
 */
export function withFileIssues(plan: SetupPlan, origin: StoredOrigin | null | undefined): SetupPlan {
  if (!origin) return plan;
  annotate(plan, origin);
  if (origin.issues.length === 0) return plan;
  return { ...plan, issues: [...pinFileIssues(plan, origin.issues), ...plan.issues], applicable: false };
}

/** "products.csv line 3, weight": the place of an issue stored before issues carried `at`. */
function placeOf(issue: SetupIssue): SetupOriginRef | undefined {
  if (issue.at) return issue.at;
  const match = /^(.+) line (\d+)(?:, (.+))?$/.exec(issue.path);
  if (!match?.[1] || !match[2]) return undefined;
  return { file: match[1], line: Number(match[2]), ...(match[3] ? { column: match[3] } : {}) };
}

/**
 * A value a file had that couldn't be read is about one line; when that line
 * became a row, the issue goes on the row too (where a person reviews it), and
 * the plan's copy says which row it is.
 */
function pinFileIssues(plan: SetupPlan, issues: SetupIssue[]): SetupIssue[] {
  const byLine = new Map<string, SetupRow>();
  for (const row of plan.rows) if (row.origin) byLine.set(`${row.origin.file}:${row.origin.line}`, row);
  return issues.map((stored) => {
    const at = placeOf(stored);
    const issue: SetupIssue = { ...stored, ...(at ? { at } : {}) };
    const row = at ? byLine.get(`${at.file}:${at.line}`) : undefined;
    if (!row) return issue;
    row.issues.push(issue);
    return { ...issue, row: { entity: row.entity, key: row.key, label: row.label } };
  });
}

/** Point each row, and each issue on it, at the file line it came from. */
function annotate(plan: SetupPlan, origin: SetupOrigin): SetupPlan {
  const ref = (at: [number, number] | undefined) => (at ? { file: origin.files[at[0]] ?? "", line: at[1] } : undefined);
  for (const row of plan.rows) {
    const rowOrigin = ref(row.entity === "material" ? origin.material[row.index] : origin.product[row.index]);
    if (!rowOrigin) continue;
    row.origin = rowOrigin;
    for (const issue of row.issues) {
      const link = /\.materials\[(\d+)\]/.exec(issue.path);
      issue.at = (link && ref(origin.links[row.index]?.[Number(link[1])])) || rowOrigin;
    }
  }
  return plan;
}

/** Replace a changeset's plan. Run inside a transaction so totals and rows always match. */
export async function savePlan(db: Db, changesetId: string, plan: SetupPlan) {
  const { rows, ...rest } = plan;
  await db.setupChangeset.update({
    where: { id: changesetId },
    data: {
      planResult: { ...rest, rows: [] } as unknown as Prisma.InputJsonValue,
      summary: summarize(plan) as unknown as Prisma.InputJsonValue,
    },
  });
  await db.setupChangesetRow.deleteMany({ where: { changesetId } });
  for (let start = 0; start < rows.length; start += ROW_BATCH) {
    await db.setupChangesetRow.createMany({
      data: rows.slice(start, start + ROW_BATCH).map((row, i) => ({
        changesetId,
        position: start + i,
        entity: row.entity,
        index: row.index,
        key: row.key,
        label: row.label,
        action: row.action,
        entityId: row.entityId,
        matchedBy: row.matchedBy,
        changes: row.changes as unknown as Prisma.InputJsonValue,
        links: (row.links ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
        issues: row.issues as unknown as Prisma.InputJsonValue,
        origin: (row.origin ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
      })),
    });
  }
}

type StoredRow = Awaited<ReturnType<typeof prisma.setupChangesetRow.findMany>>[number];

function toRow(row: StoredRow): SetupRow {
  return {
    entity: row.entity as SetupEntityKind,
    index: row.index,
    key: row.key,
    label: row.label,
    action: row.action as SetupAction,
    entityId: row.entityId,
    matchedBy: row.matchedBy as SetupRow["matchedBy"],
    changes: row.changes as unknown as SetupRow["changes"],
    ...(row.links ? { links: row.links as unknown as SetupRow["links"] } : {}),
    issues: row.issues as unknown as SetupRow["issues"],
    ...(row.origin ? { origin: row.origin as unknown as SetupRow["origin"] } : {}),
  };
}

export type SetupPlanTotals = Omit<SetupPlan, "rows">;

/** The plan without its rows: totals, spec-level issues, applicable. */
export function planTotals(changeset: { planResult: unknown }): SetupPlanTotals {
  const { rows: _rows, ...totals } = changeset.planResult as unknown as SetupPlan;
  return totals;
}

/** Rows a person has to look at before anything can be applied, for an agent's reply. */
export function problemRows(plan: SetupPlan, limit = 100): SetupRow[] {
  return plan.rows.filter((row) => row.issues.length > 0).slice(0, limit);
}

/** The whole plan, rows included, as apply compares it. */
export async function loadPlan(db: Db, changeset: { id: string; planResult: unknown }): Promise<SetupPlan> {
  const rows = await db.setupChangesetRow.findMany({
    where: { changesetId: changeset.id },
    orderBy: { position: "asc" },
  });
  return { ...planTotals(changeset), rows: rows.map(toRow) };
}

/** A slice of the stored plan, in apply order, with each row's position. */
export async function rowsFrom(db: Db, changesetId: string, position: number, take: number) {
  const rows = await db.setupChangesetRow.findMany({
    where: { changesetId, position: { gte: position } },
    orderBy: { position: "asc" },
    take,
  });
  return rows.map((row) => ({ position: row.position, row: toRow(row) }));
}

export interface RowsQuery {
  action?: SetupAction;
  /** Rows from this file (null: rows that came from no file). */
  file?: string | null;
  /** Rows that need fixing: problems, or values their file line had that couldn't be read. */
  problems?: boolean;
  entity?: SetupEntityKind;
  /** Matches key or label, case-insensitive. */
  q?: string;
  offset: number;
  limit: number;
}

export async function pageRows(changesetId: string, query: RowsQuery) {
  const where: Prisma.SetupChangesetRowWhereInput = {
    changesetId,
    ...(query.action ? { action: query.action } : {}),
    ...(query.entity ? { entity: query.entity } : {}),
    ...(query.file !== undefined
      ? { origin: query.file === null ? { equals: Prisma.DbNull } : { path: ["file"], equals: query.file } }
      : {}),
    AND: [
      query.problems ? { OR: [{ action: "conflict" }, { NOT: { issues: { equals: [] } } }] } : {},
      query.q
        ? {
            OR: [
              { key: { contains: query.q, mode: "insensitive" } },
              { label: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {},
    ],
  };
  const [total, rows] = await Promise.all([
    prisma.setupChangesetRow.count({ where }),
    prisma.setupChangesetRow.findMany({
      where,
      orderBy: { position: "asc" },
      skip: query.offset,
      take: query.limit,
    }),
  ]);
  return { total, rows: rows.map(toRow) };
}

export interface SetupFileTotals {
  /** The file's name; null for rows that came from no file (an inline spec). */
  file: string | null;
  counts: Record<SetupAction, number>;
  /** Rows that need fixing, including rows whose line had a value that couldn't be read. */
  problems: number;
}

/** Each file's share of the plan, in the order the files were mapped. */
export async function fileTotals(changesetId: string, files: string[]): Promise<SetupFileTotals[]> {
  const grouped = await prisma.$queryRaw<
    Array<{ file: string | null; action: SetupAction; rows: number; problems: number }>
  >`
    SELECT origin->>'file' AS file, action,
      count(*)::int AS rows,
      count(*) FILTER (WHERE action = 'conflict' OR jsonb_array_length(issues) > 0)::int AS problems
    FROM "SetupChangesetRow" WHERE "changesetId" = ${changesetId}::uuid
    GROUP BY 1, 2`;
  const byFile = new Map<string | null, SetupFileTotals>();
  for (const name of files) byFile.set(name, { file: name, counts: emptyCounts(), problems: 0 });
  for (const row of grouped) {
    const totals = byFile.get(row.file) ?? { file: row.file, counts: emptyCounts(), problems: 0 };
    totals.counts[row.action] += row.rows;
    totals.problems += row.problems;
    byFile.set(row.file, totals);
  }
  return [...byFile.values()];
}

function emptyCounts(): Record<SetupAction, number> {
  return { create: 0, update: 0, unchanged: 0, conflict: 0 };
}

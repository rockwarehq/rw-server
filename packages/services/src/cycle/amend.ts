import { Prisma } from "@rw/db";
import type { AmendContext } from "../history/context.js";
import type { ResolvedStandards } from "./standards.js";

/**
 * A cycle's earned standard as resolveCycleActuals stamps it at record time,
 * for restamping stored cycles in SQL: quantity x seconds-per-unit on a rate,
 * else the flat standard (none for an interval report without a rate).
 */
export function earnedStandardCycleSql(
  std: Pick<ResolvedStandards, "mode" | "secondsPerUnit" | "standardCycleSeconds">,
): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN ${std.mode} <> 'DISCRETE' AND ${std.secondsPerUnit}::float8 IS NOT NULL AND "quantity" IS NOT NULL
      THEN "quantity" * ${std.secondsPerUnit}::float8
    WHEN ${std.mode} = 'QUANTITY_PER_INTERVAL' THEN NULL
    ELSE ${std.standardCycleSeconds}::float8
  END`;
}

/**
 * Point the window's cycles at the amended job: stable id, version, standards
 * snapshot, and the tool join tables. Attribution is by cycle end (an open
 * cycle counts as ending now), matching the bucket tallies. Cycles need a job
 * version, so a "no job" amendment leaves them as recorded.
 */
export async function restampCycles(ctx: AmendContext): Promise<{ cycleIds: string[] }> {
  const { tx, stationId, from, toEff, job, amendmentId } = ctx;
  if (!job) return { cycleIds: [] };

  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "Cycle"
    SET "jobId" = ${job.id}::uuid,
        "jobVersionId" = ${job.versionId}::uuid,
        "standardCycle" = ${earnedStandardCycleSql({ ...job, standardCycleSeconds: job.standardCycle })},
        "standardQuantity" = ${job.standardQuantity},
        "quantityUnit" = ${job.quantityUnit},
        "amendmentId" = ${amendmentId}::uuid,
        "updatedAt" = NOW()
    WHERE "stationId" = ${stationId}::uuid
      AND "deletedAt" IS NULL
      AND COALESCE("end", NOW()) >= ${from}
      AND COALESCE("end", NOW()) < ${toEff}
    RETURNING id
  `;
  const cycleIds = rows.map((r) => r.id);
  if (cycleIds.length === 0) return { cycleIds };

  await tx.$executeRaw`DELETE FROM "_CycleToJobTool" WHERE "A" = ANY(${cycleIds}::uuid[])`;
  await tx.$executeRaw`DELETE FROM "_CycleToToolVersion" WHERE "A" = ANY(${cycleIds}::uuid[])`;
  await tx.$executeRaw`
    INSERT INTO "_CycleToJobTool" ("A", "B")
    SELECT c.id, jt.id
    FROM unnest(${cycleIds}::uuid[]) AS c(id)
    CROSS JOIN "JobTool" jt
    WHERE jt."jobId" = ${job.id}::uuid AND jt."deletedAt" IS NULL AND jt."isActive" = true
    ON CONFLICT DO NOTHING
  `;
  await tx.$executeRaw`
    INSERT INTO "_CycleToToolVersion" ("A", "B")
    SELECT c.id, t."currentVersionId"
    FROM unnest(${cycleIds}::uuid[]) AS c(id)
    CROSS JOIN "JobTool" jt
    JOIN "Tool" t ON t.id = jt."toolId"
    WHERE jt."jobId" = ${job.id}::uuid AND jt."deletedAt" IS NULL AND jt."isActive" = true
      AND t."currentVersionId" IS NOT NULL
    ON CONFLICT DO NOTHING
  `;
  return { cycleIds };
}

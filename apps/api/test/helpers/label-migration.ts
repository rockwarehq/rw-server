import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

/** Replay the checked-in migration in a private schema, rolled back even when an assertion fails. */
export async function withLegacyLabelSchema(
  verify: (client: pg.Client, ids: Record<string, string>, migrate: () => Promise<void>) => Promise<void>,
) {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("Label migration fixture requires TEST_DATABASE_URL");
  const client = new pg.Client({ connectionString });
  const schema = `label_migration_${randomUUID().replaceAll("-", "")}`;
  const ids = Object.fromEntries([
    "siteA", "siteB", "station", "stationVersion", "toolA", "toolB", "job", "deletedProcessJob",
    "stationClass", "collidingToolClass", "otherSiteClass", "toolClass", "process", "deletedProcess", "statusReason", "scrapReason",
  ].map((name) => [name, randomUUID()]));

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    // Deliberately omit public: no statement in the replay can resolve a real tenant table.
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(`
      CREATE TYPE "ToolClassificationType" AS ENUM ('TEST');
      CREATE TYPE "StationClassificationType" AS ENUM ('TEST');
      CREATE TABLE "Site" ("id" uuid PRIMARY KEY);
      CREATE TABLE "Station" ("id" uuid PRIMARY KEY, "currentVersionId" uuid);
      CREATE TABLE "Tool" ("id" uuid PRIMARY KEY);
      CREATE TABLE "Product" ("id" uuid PRIMARY KEY);
      CREATE TABLE "Material" ("id" uuid PRIMARY KEY);
      CREATE TABLE "StatusReason" ("id" uuid PRIMARY KEY);
      CREATE TABLE "ProcessType" (
        "id" uuid PRIMARY KEY, "name" text NOT NULL, "siteId" uuid REFERENCES "Site"("id"),
        "createdAt" timestamptz NOT NULL DEFAULT '2020-01-02T00:00:00Z',
        "updatedAt" timestamptz NOT NULL DEFAULT '2020-01-02T00:00:00Z', "deletedAt" timestamptz
      );
      CREATE TABLE "StationClassification" (
        "id" uuid PRIMARY KEY, "name" text NOT NULL, "siteId" uuid REFERENCES "Site"("id"),
        "createdAt" timestamptz NOT NULL DEFAULT '2020-01-02T00:00:00Z',
        "updatedAt" timestamptz NOT NULL DEFAULT '2020-01-02T00:00:00Z'
      );
      CREATE TABLE "ToolClassification" (
        "id" uuid PRIMARY KEY, "name" text NOT NULL, "siteId" uuid REFERENCES "Site"("id"),
        "createdAt" timestamptz NOT NULL DEFAULT '2020-01-02T00:00:00Z',
        "updatedAt" timestamptz NOT NULL DEFAULT '2020-01-02T00:00:00Z'
      );
      CREATE TABLE "Job" ("id" uuid PRIMARY KEY, "processTypeId" uuid REFERENCES "ProcessType"("id"));
      CREATE INDEX "Job_processTypeId_idx" ON "Job"("processTypeId");
      CREATE TABLE "ItemDispositionReason" ("id" uuid PRIMARY KEY, "processTypeId" uuid REFERENCES "ProcessType"("id"));
      CREATE TABLE "Workcenter" ("id" uuid PRIMARY KEY, "processTypeId" uuid REFERENCES "ProcessType"("id"));
      CREATE TABLE "StationVersion" ("id" uuid PRIMARY KEY, "processTypeId" uuid REFERENCES "ProcessType"("id"));
      CREATE TABLE "_StationToStationClassification" (
        "A" uuid REFERENCES "Station"("id"), "B" uuid REFERENCES "StationClassification"("id")
      );
      CREATE TABLE "_ToolToToolClassification" (
        "A" uuid REFERENCES "Tool"("id"), "B" uuid REFERENCES "ToolClassification"("id")
      );
      CREATE TABLE "_ProcessTypeToStatusReason" (
        "A" uuid REFERENCES "ProcessType"("id"), "B" uuid REFERENCES "StatusReason"("id")
      );
    `);
    await client.query('INSERT INTO "Site" VALUES ($1), ($2)', [ids.siteA, ids.siteB]);
    await client.query('INSERT INTO "StationClassification" ("id", "name", "siteId") VALUES ($1, $2, $3), ($4, $2, $5)',
      [ids.stationClass, "Night Crew", ids.siteA, ids.otherSiteClass, ids.siteB]);
    await client.query('INSERT INTO "ToolClassification" ("id", "name", "siteId") VALUES ($1, $2, $3), ($4, $5, $3)',
      [ids.collidingToolClass, "Night Crew", ids.siteA, ids.toolClass, "Fixtures"]);
    await client.query('INSERT INTO "ProcessType" ("id", "name", "siteId", "deletedAt") VALUES ($1, $2, $3, NULL), ($4, $5, $3, now())',
      [ids.process, "Molding", ids.siteA, ids.deletedProcess, "Obsolete"]);
    await client.query('INSERT INTO "Station" VALUES ($1, $2)', [ids.station, ids.stationVersion]);
    await client.query('INSERT INTO "StationVersion" VALUES ($1, $2)', [ids.stationVersion, ids.process]);
    await client.query('INSERT INTO "Tool" VALUES ($1), ($2)', [ids.toolA, ids.toolB]);
    await client.query('INSERT INTO "Job" VALUES ($1, $2), ($3, $4)', [ids.job, ids.process, ids.deletedProcessJob, ids.deletedProcess]);
    await client.query('INSERT INTO "StatusReason" VALUES ($1)', [ids.statusReason]);
    await client.query('INSERT INTO "ItemDispositionReason" VALUES ($1, $2)', [ids.scrapReason, ids.process]);
    await client.query('INSERT INTO "_StationToStationClassification" VALUES ($1, $2)', [ids.station, ids.stationClass]);
    await client.query('INSERT INTO "_ToolToToolClassification" VALUES ($1, $2), ($3, $4)',
      [ids.toolA, ids.collidingToolClass, ids.toolB, ids.toolClass]);
    await client.query('INSERT INTO "_ProcessTypeToStatusReason" VALUES ($1, $2)', [ids.process, ids.statusReason]);

    await verify(client, ids, async () => {
      const sql = await readFile(new URL("../../../../packages/db/migrations/20260824140000_labels/migration.sql", import.meta.url), "utf8");
      await client.query(sql);
    });
  } finally {
    try { await client.query("ROLLBACK"); } finally { await client.end(); }
  }
}

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { LEGACY_CUSTOM_PERMISSION_CATALOG } from "@rw/auth/iam/permissions";
import { createPermissionPreviewClient, type PermissionPreviewClient } from "../../scripts/preview-permission-migration.js";

const bundle = (resources: string[]) => resources.flatMap((r) => ["read", "write", "admin"].map((a) => `${r}:${a}`));

export interface PermissionMigrationFixture {
  client: PermissionPreviewClient;
  ids: Record<string, string>;
  schema: string;
  /** Same test database, restricted to the committed private schema and read-only by default. */
  previewDatabaseUrl: string;
  migrate: () => Promise<void>;
}

/**
 * Committed private-schema fixture: enum ADD VALUE is committed before any
 * WORKCENTER enum inserts. A second connection can exercise the actual CLI
 * before/after migration. Always drop the scratch schema, including on failure.
 * Public is absent from search_path, so migration SQL cannot resolve tenant tables.
 */
export async function withPermissionMigrationSchema(verify: (fixture: PermissionMigrationFixture) => Promise<void>) {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("Permission migration fixture requires TEST_DATABASE_URL");
  const schema = `permission_migration_${randomUUID().replaceAll("-", "")}`;
  const client = createPermissionPreviewClient(connectionString);
  const names = [
    "workspace", "otherWorkspace", "site", "otherSite", "workcenter", "secondWorkcenter", "otherWorkcenter",
    "station", "otherStation", "user", "otherUser", "employee", "otherEmployee", "membership", "otherMembership",
    "company", "admin", "member", "plannerCustom", "readCustom", "configurationCustom", "plantCustom", "partialCustom",
    "collision", "unknownSystem", "otherRole", "readGrant", "writeGrant", "otherGrant",
    "fixedDisplay", "siteDisplay", "missingBootstrapDisplay", "unclaimedDisplay", "otherDisplay", "refreshToken",
    "userComment", "unknownComment", "employeeComment", "workcenterRole", "workcenterAssignment",
  ];
  const ids: Record<string, string> = Object.fromEntries(names.map((name) => [name, randomUUID()]));
  const previewUrl = new URL(connectionString);
  previewUrl.searchParams.set("options", `-c search_path=${schema} -c default_transaction_read_only=on`);
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TYPE "RoleScope" AS ENUM ('WORKSPACE', 'SITE');
      CREATE TYPE "WorkcenterAccess" AS ENUM ('READ', 'WRITE');
      CREATE TYPE "DisplayStatus" AS ENUM ('UNCLAIMED', 'CLAIMED');
      CREATE TABLE "Workspace" ("id" uuid PRIMARY KEY, "name" text NOT NULL);
      CREATE TABLE "Site" ("id" uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES "Workspace", "name" text NOT NULL);
      CREATE TABLE "User" ("id" uuid PRIMARY KEY);
      CREATE TABLE "Employee" ("id" uuid PRIMARY KEY);
      CREATE TABLE "WorkspaceMember" (
        "id" uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES "Workspace", "userId" uuid NOT NULL REFERENCES "User"
      );
      CREATE TABLE "Workcenter" (
        "id" uuid PRIMARY KEY, "siteId" uuid NOT NULL REFERENCES "Site", "name" text NOT NULL
      );
      CREATE TABLE "Station" (
        "id" uuid PRIMARY KEY, "siteId" uuid NOT NULL REFERENCES "Site", "workcenterId" uuid REFERENCES "Workcenter"
      );
      CREATE TABLE "Role" (
        "id" uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES "Workspace", "name" text NOT NULL,
        "description" text, "scope" "RoleScope" NOT NULL, "permissions" text[] NOT NULL, "isSystem" boolean NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT '2020-01-02T00:00:00Z',
        "updatedAt" timestamptz NOT NULL DEFAULT '2020-01-02T00:00:00Z',
        UNIQUE ("workspaceId", "name", "scope")
      );
      CREATE TABLE "RoleAssignment" (
        "id" uuid PRIMARY KEY, "membershipId" uuid NOT NULL REFERENCES "WorkspaceMember",
        "roleId" uuid NOT NULL REFERENCES "Role", "siteId" uuid REFERENCES "Site",
        "createdAt" timestamptz NOT NULL DEFAULT '2020-01-02T00:00:00Z'
      );
      CREATE TABLE "WorkcenterGrant" (
        "id" uuid PRIMARY KEY, "membershipId" uuid NOT NULL REFERENCES "WorkspaceMember",
        "workcenterId" uuid NOT NULL REFERENCES "Workcenter", "access" "WorkcenterAccess" NOT NULL,
        UNIQUE ("membershipId", "workcenterId")
      );
      CREATE TABLE "Display" (
        "id" uuid PRIMARY KEY, "status" "DisplayStatus" NOT NULL,
        "siteId" uuid REFERENCES "Site", "stationId" uuid, "workcenterId" uuid REFERENCES "Workcenter",
        "bootstrapSecretHash" text, "bootstrapSecretCreatedAt" timestamptz, "bootstrapSecretLastUsedAt" timestamptz,
        CONSTRAINT "Display_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station" ON DELETE SET NULL
      );
      CREATE TABLE "DisplayRefreshToken" (
        "id" uuid PRIMARY KEY, "displayId" uuid NOT NULL REFERENCES "Display",
        "tokenHash" text NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL, "revokedAt" timestamptz, "rotatedAt" timestamptz
      );
      CREATE TABLE "ShiftComment" (
        "id" uuid PRIMARY KEY, "siteId" uuid NOT NULL REFERENCES "Site", "workcenterId" uuid NOT NULL REFERENCES "Workcenter",
        "stationId" uuid REFERENCES "Station" ON DELETE SET NULL, "text" text NOT NULL,
        "createdById" uuid REFERENCES "User" ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT '2020-01-02T00:00:00Z',
        "updatedAt" timestamptz NOT NULL DEFAULT '2020-01-02T00:00:00Z'
      );
    `);
    await client.query('INSERT INTO "Workspace" VALUES ($1, $2), ($3, $4)', [ids.workspace, "Fixture plant", ids.otherWorkspace, "Other company"]);
    await client.query('INSERT INTO "Site" VALUES ($1, $2, $3), ($4, $5, $6)', [ids.site, ids.workspace, "Plant A", ids.otherSite, ids.otherWorkspace, "Plant B"]);
    await client.query('INSERT INTO "User" VALUES ($1), ($2)', [ids.user, ids.otherUser]);
    await client.query('INSERT INTO "Employee" VALUES ($1), ($2)', [ids.employee, ids.otherEmployee]);
    await client.query('INSERT INTO "WorkspaceMember" VALUES ($1, $2, $3), ($4, $5, $6)', [ids.membership, ids.workspace, ids.user, ids.otherMembership, ids.otherWorkspace, ids.otherUser]);
    await client.query('INSERT INTO "Workcenter" VALUES ($1, $2, $3), ($4, $2, $5), ($6, $7, $8)', [ids.workcenter, ids.site, "Line A", ids.secondWorkcenter, "Line B", ids.otherWorkcenter, ids.otherSite, "Other line"]);
    await client.query('INSERT INTO "Station" VALUES ($1, $2, $3), ($4, $5, $6)', [ids.station, ids.site, ids.workcenter, ids.otherStation, ids.otherSite, ids.otherWorkcenter]);

    const roleRows = [
      { key: "company", name: "Company Administrator", system: true, scope: "WORKSPACE", permissions: [...LEGACY_CUSTOM_PERMISSION_CATALOG, "owner:all"] },
      { key: "admin", name: "Plant Admin", system: true, scope: "SITE", permissions: [...LEGACY_CUSTOM_PERMISSION_CATALOG] },
      { key: "member", name: "Plant Member", system: true, scope: "SITE", permissions: LEGACY_CUSTOM_PERMISSION_CATALOG.filter((p) => p.endsWith(":read")) },
      { key: "plannerCustom", name: "Scheduling team", system: false, scope: "SITE", permissions: ["schedule:admin", ...bundle(["job", "schedule"]), "job:read"] },
      { key: "readCustom", name: "Read everything", system: false, scope: "SITE", permissions: LEGACY_CUSTOM_PERMISSION_CATALOG.filter((p) => p.endsWith(":read")) },
      { key: "configurationCustom", name: "Technical team", system: false, scope: "SITE", permissions: bundle(["facility", "job", "status", "calls", "modes", "notifications", "dashboard", "entity", "graph", "settings"]) },
      { key: "plantCustom", name: "People administrators", system: false, scope: "SITE", permissions: bundle(["user", "employee", "settings"]) },
      { key: "partialCustom", name: "Call supervisors", system: false, scope: "SITE", permissions: ["calls:admin"] },
      { key: "collision", name: "Planner", system: false, scope: "SITE", permissions: ["job:read", "schedule:read"] },
      { key: "unknownSystem", name: "Historical system role", system: true, scope: "SITE", permissions: ["facility:read"] },
      { key: "otherRole", name: "Other company role", system: false, scope: "SITE", permissions: ["job:read"] },
    ];
    for (const role of roleRows) {
      const other = role.key === "otherRole";
      await client.query(`INSERT INTO "Role" ("id", "workspaceId", "name", "scope", "permissions", "isSystem")
        VALUES ($1, $2, $3, $4::"RoleScope", $5::text[], $6)`,
      [ids[role.key], other ? ids.otherWorkspace : ids.workspace, role.name, role.scope, role.permissions, role.system]);
      await client.query('INSERT INTO "RoleAssignment" ("id", "membershipId", "roleId", "siteId") VALUES ($1, $2, $3, $4)',
        [randomUUID(), other ? ids.otherMembership : ids.membership, ids[role.key], role.scope === "WORKSPACE" ? null : other ? ids.otherSite : ids.site]);
    }
    await client.query(`INSERT INTO "WorkcenterGrant" VALUES ($1, $2, $3, 'READ'), ($4, $2, $5, 'WRITE'), ($6, $7, $8, 'WRITE')`,
      [ids.readGrant, ids.membership, ids.workcenter, ids.writeGrant, ids.secondWorkcenter, ids.otherGrant, ids.otherMembership, ids.otherWorkcenter]);
    for (const [key, site, station, workcenter, status, secret] of [
      ["fixedDisplay", ids.site, ids.station, ids.workcenter, "CLAIMED", "fixture-bootstrap-do-not-print"],
      ["siteDisplay", ids.site, null, ids.workcenter, "CLAIMED", "fixture-site-bootstrap-do-not-print"],
      ["missingBootstrapDisplay", ids.site, null, null, "CLAIMED", null],
      ["unclaimedDisplay", null, null, null, "UNCLAIMED", null],
      ["otherDisplay", ids.otherSite, ids.otherStation, ids.otherWorkcenter, "CLAIMED", "fixture-other-bootstrap-do-not-print"],
    ] as const) {
      await client.query(`INSERT INTO "Display" VALUES ($1, $2::"DisplayStatus", $3, $4, $5, $6, '2020-01-02', '2020-01-03')`,
        [ids[key], status, site, station, workcenter, secret]);
    }
    await client.query(`INSERT INTO "DisplayRefreshToken" VALUES ($1, $2, $3, '2030-01-01', NULL, NULL)`,
      [ids.refreshToken, ids.fixedDisplay, "fixture-refresh-token-do-not-print"]);
    await client.query(`INSERT INTO "ShiftComment" ("id", "siteId", "workcenterId", "stationId", "text", "createdById")
      VALUES ($1, $2, $3, $4, 'Attributed legacy comment', $5), ($6, $2, $3, $4, 'Unattributed legacy comment', NULL)`,
      [ids.userComment, ids.site, ids.workcenter, ids.station, ids.user, ids.unknownComment]);
    await client.query("COMMIT");
    await verify({
      client, ids, schema, previewDatabaseUrl: previewUrl.toString(),
      migrate: async () => {
        for (const migration of ["20260923000000_simplify_permissions", "20260923001000_terminal_comment_authorship"]) {
          const sql = await readFile(new URL(`../../../../packages/db/migrations/${migration}/migration.sql`, import.meta.url), "utf8");
          await client.query("BEGIN");
          await client.query(sql);
          await client.query("COMMIT");
        }
      },
    });
  } finally {
    try {
      await client.query("ROLLBACK");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await client.end();
    }
  }
}

/** Expected database rejection must not leave subsequent assertions in an aborted transaction. */
export async function rejectedMigrationQuery(client: PermissionPreviewClient, sql: string, values: unknown[]): Promise<string | null> {
  await client.query("BEGIN");
  try {
    await client.query(sql, values);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  } finally {
    await client.query("ROLLBACK");
  }
}

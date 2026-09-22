import { resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { PermissionMigrationDataset } from "../src/services/account/permission-migration.js";

/** Small typed pg protocol so the standalone script does not depend on ambient @types/pg. */
export interface PermissionPreviewClient {
  connect(): Promise<void>;
  query<Row extends object = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
}

const pg = createRequire(import.meta.url)("pg") as {
  Client: new (options: { connectionString: string; connectionTimeoutMillis: number }) => PermissionPreviewClient;
};

export function createPermissionPreviewClient(connectionString: string): PermissionPreviewClient {
  return new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 });
}

export const PERMISSION_PREVIEW_HELP = `Usage: pnpm exec tsx apps/api/scripts/preview-permission-migration.ts [--json] [--workspace-id UUID]

Read-only preview of permission simplification and existing terminal bindings.
Requires DATABASE_URL explicitly in the environment. Works before or after migration.

  --json                 Emit one JSON document instead of a human summary
  --workspace-id UUID    Restrict the preview to one workspace
  --help, -h             Show this help without connecting to a database

There is no apply/write option. Credential values and connection URLs are never printed.`;

export function parsePermissionPreviewArgs(args: readonly string[]) {
  if (args.includes("--help") || args.includes("-h")) return { help: true, json: false, workspaceId: undefined };
  let json = false;
  let workspaceId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") json = true;
    else if (arg === "--workspace-id" || arg.startsWith("--workspace-id=")) {
      if (workspaceId !== undefined) throw new Error("Specify --workspace-id only once.");
      const value = arg === "--workspace-id" ? args[++i] : arg.slice("--workspace-id=".length);
      if (!value || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
        throw new Error("--workspace-id requires a UUID.");
      }
      workspaceId = value.toLowerCase();
    } else throw new Error("Unknown option. Use --help; there is no apply/write option.");
  }
  return { help: false, json, workspaceId };
}

/** Only stable pre-upgrade columns are named directly. JSON projections safely probe new nullable columns. */
export async function readPermissionMigrationDataset(
  client: PermissionPreviewClient,
  workspaceId?: string,
): Promise<PermissionMigrationDataset> {
  const values = [workspaceId ?? null];
  const workspaces = await client.query<PermissionMigrationDataset["workspaces"][number]>(
    `
    SELECT "id", "name" FROM "Workspace"
    WHERE ($1::uuid IS NULL OR "id" = $1::uuid) ORDER BY "id"
  `,
    values,
  );
  const roles = await client.query<PermissionMigrationDataset["roles"][number]>(
    `
    SELECT r."id", r."workspaceId", r."name", r."scope"::text AS "scope", r."isSystem", r."permissions",
      to_jsonb(r)->'legacyPermissions' AS "legacyPermissions",
      to_jsonb(r) ? 'legacyPermissions' AS "hasLegacyPermissionsColumn"
    FROM "Role" r WHERE ($1::uuid IS NULL OR r."workspaceId" = $1::uuid)
    ORDER BY r."workspaceId", r."name", r."id"
  `,
    values,
  );
  const assignments = await client.query<PermissionMigrationDataset["assignments"][number]>(
    `
    SELECT a."id", a."roleId", a."membershipId", a."siteId",
      to_jsonb(a)->>'workcenterId' AS "workcenterId"
    FROM "RoleAssignment" a JOIN "Role" r ON r."id" = a."roleId"
    WHERE ($1::uuid IS NULL OR r."workspaceId" = $1::uuid) ORDER BY a."id"
  `,
    values,
  );
  const grants = await client.query<PermissionMigrationDataset["workcenterGrants"][number]>(
    `
    SELECT g."id", m."workspaceId", g."membershipId", g."workcenterId", w."siteId", g."access"::text AS "access"
    FROM "WorkcenterGrant" g
    JOIN "WorkspaceMember" m ON m."id" = g."membershipId"
    JOIN "Workcenter" w ON w."id" = g."workcenterId"
    WHERE ($1::uuid IS NULL OR m."workspaceId" = $1::uuid) ORDER BY g."id"
  `,
    values,
  );
  const displays = await client.query<PermissionMigrationDataset["displays"][number]>(
    `
    SELECT d."id", s."workspaceId", d."siteId", d."stationId", d."workcenterId", d."status"::text AS "status",
      (d."bootstrapSecretHash" IS NOT NULL AND d."bootstrapSecretHash" <> '') AS "hasBootstrapSecret"
    FROM "Display" d LEFT JOIN "Site" s ON s."id" = d."siteId"
    WHERE d."status" = 'CLAIMED' AND ($1::uuid IS NULL OR s."workspaceId" = $1::uuid) ORDER BY d."id"
  `,
    values,
  );
  return {
    workspaces: workspaces.rows,
    roles: roles.rows,
    assignments: assignments.rows,
    workcenterGrants: grants.rows,
    displays: displays.rows,
  };
}

export async function loadPermissionMigrationPreview(connectionString: string, workspaceId?: string) {
  const client = createPermissionPreviewClient(connectionString);
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const mode = await client.query<{ transaction_read_only: string }>("SHOW transaction_read_only");
    if (mode.rows[0]?.transaction_read_only !== "on") throw new Error("Read-only transaction required");
    // Imported only after the CLI has checked DATABASE_URL; no seed function is called.
    const { buildPermissionMigrationPreview } = await import("../src/services/account/permission-migration.js");
    const report = buildPermissionMigrationPreview(
      await readPermissionMigrationDataset(client, workspaceId),
      workspaceId,
    );
    await client.query("ROLLBACK");
    return { ...report, databaseReadOnly: true as const };
  } finally {
    await client.end();
  }
}

export async function permissionPreviewMain(args = process.argv.slice(2)): Promise<void> {
  let options: ReturnType<typeof parsePermissionPreviewArgs>;
  try {
    options = parsePermissionPreviewArgs(args);
  } catch (error) {
    // Parser errors are fixed messages: never echo arbitrary input, URLs, or pg error details.
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${PERMISSION_PREVIEW_HELP}\n`);
    return;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write("DATABASE_URL must be set explicitly to run the read-only preview.\n");
    process.exitCode = 1;
    return;
  }
  try {
    const report = await loadPermissionMigrationPreview(connectionString, options.workspaceId);
    const { formatPermissionMigrationPreview } = await import("../src/services/account/permission-migration.js");
    process.stdout.write(
      `${options.json ? JSON.stringify(report, null, 2) : formatPermissionMigrationPreview(report)}\n`,
    );
  } catch {
    process.stderr.write(
      "Permission migration preview failed. Check database connectivity and the expected pre-upgrade or migrated schema. No changes were applied.\n",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await permissionPreviewMain();
}

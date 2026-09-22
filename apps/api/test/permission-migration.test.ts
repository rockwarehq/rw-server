import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { LEGACY_CUSTOM_PERMISSION_CATALOG, mapLegacyCustomPermissions } from "@rw/auth/iam/permissions";
import { SYSTEM_ROLE_SPECS } from "../src/seed-system-roles.js";
import {
  buildPermissionMigrationPreview,
  formatPermissionMigrationPreview,
  previewPermissionRole,
  previewWorkcenterGrant,
  type MigrationRoleRow,
  type PermissionMigrationDataset,
  type PermissionMigrationPreview,
} from "../src/services/account/permission-migration.js";
import { parsePermissionPreviewArgs } from "../scripts/preview-permission-migration.js";
import { rejectedMigrationQuery, withPermissionMigrationSchema } from "./helpers/permission-migration.js";

// Importing SYSTEM_ROLE_SPECS must not execute a seed or access Prisma. The real
// database fixture below uses only its own pg.Client and isolated scratch schema.
vi.mock("@rw/db", () => ({ default: {} }));

const role = (overrides: Partial<MigrationRoleRow> = {}): MigrationRoleRow => ({
  id: "custom", workspaceId: "workspace", name: "Scheduling", scope: "SITE", isSystem: false,
  permissions: ["job:read", "schedule:read"], ...overrides,
});
const dataset = (): PermissionMigrationDataset => ({
  workspaces: [{ id: "workspace", name: "A" }, { id: "other-workspace", name: "B" }],
  roles: [role(), role({ id: "other", workspaceId: "other-workspace" })],
  assignments: [{ id: "assignment", roleId: "custom", membershipId: "member", siteId: "site" }],
  workcenterGrants: [{ id: "grant", workspaceId: "workspace", membershipId: "member", siteId: "site", workcenterId: "wc", access: "WRITE" }],
  displays: [
    { id: "fixed", workspaceId: "workspace", siteId: "site", stationId: "station", workcenterId: "wc", status: "CLAIMED", hasBootstrapSecret: true },
    { id: "free", workspaceId: "workspace", siteId: "site", stationId: null, workcenterId: "wc", status: "CLAIMED", hasBootstrapSecret: true },
    { id: "missing", workspaceId: "workspace", siteId: "site", stationId: null, workcenterId: null, status: "CLAIMED", hasBootstrapSecret: false },
    { id: "unclaimed", workspaceId: null, siteId: null, stationId: null, workcenterId: null, status: "UNCLAIMED", hasBootstrapSecret: false },
  ],
});

const exec = promisify(execFile);
const apiRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = fileURLToPath(new URL("../scripts/preview-permission-migration.ts", import.meta.url));
async function runCli(args: string[], databaseUrl?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test" };
  for (const key of ["DATABASE_URL", "DATABASE_URL_READ", "DATABASE_URL_MIGRATION"]) delete env[key];
  if (databaseUrl) {
    for (const key of ["DATABASE_URL", "DATABASE_URL_READ", "DATABASE_URL_MIGRATION"]) env[key] = databaseUrl;
  }
  try {
    const result = await exec(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: apiRoot, env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { status: result.code ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

describe("pure permission migration previews", () => {
  it.each(SYSTEM_ROLE_SPECS)("uses the exact built-in spec for $name, independent of its legacy array", (spec) => {
    const report = previewPermissionRole(role({ name: spec.name, scope: spec.scope, isSystem: true, permissions: ["calls:read"] }), []);
    expect(report.proposedPermissions).toEqual(spec.permissions);
    expect(report.classification).toBe("BUILT_IN");
    expect(report.customMapping).toBeNull();
  });

  it("uses complete custom bundles and exposes missing prerequisites alongside unchanged assignment bindings", () => {
    const data = dataset();
    data.roles[0].permissions = ["job:read", "job:write", "job:admin", "schedule:read", "schedule:write", "schedule:admin"];
    const before = structuredClone(data);
    const report = buildPermissionMigrationPreview(data, "workspace");
    expect(report.roles[0].proposedPermissions).toEqual(["planning:read", "planning:write"]);
    expect(report.roles[0].customMapping?.requirements.find((r) => r.permission === "production:admin"))
      .toMatchObject({ granted: false, missingPermissions: expect.arrayContaining(["calls:read"]) });
    expect(report.roles[0].assignments[0]).toMatchObject({
      id: "assignment", membershipId: "member", siteId: "site", workcenterId: null, scope: "SITE", scopeMismatch: false,
    });
    expect(report.summary.affectedAssignments).toBe(1);
    expect(report.workspaces).toEqual([{ id: "workspace", name: "A" }]);
    expect(data).toEqual(before);
  });

  it("reads an exact backup after migration and separates later edits from the historical proposal", () => {
    const backup = ["job:read", "schedule:read", "job:read"];
    const report = previewPermissionRole(role({
      permissions: ["configuration:write"], legacyPermissions: backup, hasLegacyPermissionsColumn: true,
    }), []);
    expect(report.source).toBe("MIGRATION_BACKUP");
    expect(report.originalPermissions).toEqual(backup);
    expect(report.proposedPermissions).toEqual(["planning:read"]);
    expect(report.storedPermissions).toEqual(["configuration:write"]);
    expect(report.differsFromStored).toBe(true);
    expect(report.requiresReview).toBe(true);
    const fresh = previewPermissionRole(role({ permissions: ["production:write"], legacyPermissions: null, hasLegacyPermissionsColumn: true }), []);
    expect(fresh).toMatchObject({ source: "CURRENT_PERMISSIONS", schemaState: "MIGRATED", proposedPermissions: ["production:write"] });
  });

  it("reports malformed backups and unknown system roles without inventing a built-in migration", () => {
    const invalid = previewPermissionRole(role({ legacyPermissions: { secret: "never-print-this" } }), []);
    expect(invalid.backupIssue).toBeTruthy();
    expect(JSON.stringify(invalid)).not.toContain("never-print-this");
    const unknown = previewPermissionRole(role({ name: "Historical system", isSystem: true, permissions: ["facility:read"] }), []);
    expect(unknown).toMatchObject({ classification: "UNKNOWN_SYSTEM_ROLE", proposedPermissions: ["facility:read"], requiresReview: true });
  });

  it("does not replace colliding custom roles or promote them to Company Administrator", () => {
    const data = dataset();
    data.roles[0] = role({ name: "Company Administrator", scope: "WORKSPACE", permissions: [...LEGACY_CUSTOM_PERMISSION_CATALOG] });
    const report = buildPermissionMigrationPreview(data, "workspace");
    expect(report.roleNameCollisions).toHaveLength(1);
    expect(report.roles[0].proposedPermissions).not.toContain("owner:all");
    expect(report.builtInsToCreate.some((r) => r.name === "Company Administrator")).toBe(false);
    expect(report.roles[0].assignments[0].scopeMismatch).toBe(true);
  });

  it("shows WC WRITE global-write losses without promoting its row or synthesizing site permissions", () => {
    const grant = previewWorkcenterGrant(dataset().workcenterGrants[0]);
    expect(grant).toMatchObject({ access: "WRITE", proposedAccess: "WRITE", promotedToEngineer: false });
    expect(grant.scopedPermissions).toEqual(["production:read", "production:write"]);
    expect(grant.removedSiteGlobalWrites).toEqual([
      "job:write", "schedule:write", "tool:write", "product:write", "entity:write", "graph:write", "dashboard:write",
    ]);
    expect(previewWorkcenterGrant({ ...dataset().workcenterGrants[0], access: "READ" }).removedSiteGlobalWrites).toEqual([]);
  });

  it("reports claimed display binding/counts/IDs and excludes all credential values", () => {
    const data = dataset();
    Object.assign(data.displays[0], { bootstrapSecretHash: "never-print-bootstrap", tokenHash: "never-print-token" });
    const report = buildPermissionMigrationPreview(data);
    expect(report.displays.stationBound).toEqual({ count: 1, ids: ["fixed"] });
    expect(report.displays.siteBound).toEqual({ count: 2, ids: ["free", "missing"] });
    expect(report.displays.missingBootstrap).toEqual({ count: 1, ids: ["missing"] });
    expect(report.summary.claimedDisplays).toBe(3);
    expect(JSON.stringify(report)).not.toMatch(/never-print|bootstrapSecretHash|tokenHash/);
    const human = formatPermissionMigrationPreview(report);
    expect(human).toContain("Missing display bootstrap: 1 [missing]");
    expect(human).toContain("production:admin: missing");
    expect(human).not.toMatch(/never-print|bootstrapSecretHash|tokenHash/);
  });

  it("validates CLI arguments and has no write/apply option", () => {
    const id = randomUUID();
    expect(parsePermissionPreviewArgs(["--json", `--workspace-id=${id}`])).toMatchObject({ json: true, workspaceId: id });
    expect(() => parsePermissionPreviewArgs(["--workspace-id", "not-an-id"])).toThrow(/UUID/);
    expect(() => parsePermissionPreviewArgs(["--apply"])).toThrow(/no apply\/write option/);
  });

  it("CLI help is offline and the environment URL must be explicit", async () => {
    const help = await runCli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage:");
    expect(help.stderr).toBe("");
    const missing = await runCli(["--json"]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("DATABASE_URL must be set explicitly");
    const refused = await runCli(["--apply"], "postgresql://secret-user:secret-password@127.0.0.1:1/private");
    expect(refused.status).toBe(1);
    expect(refused.stderr).not.toMatch(/secret-user|secret-password|postgresql/);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("populated permission and terminal migrations", () => {
  it("preserves legacy identities/credentials, applies exact role rules, and supports the real read-only CLI on both schemas", async () => {
    await withPermissionMigrationSchema(async ({ client, ids, previewDatabaseUrl, migrate }) => {
      const originalRoles = (await client.query<MigrationRoleRow>('SELECT * FROM "Role" ORDER BY "id"')).rows;
      const protectedState = async () => ({
        assignments: (await client.query(`SELECT to_jsonb(a) - 'workcenterId' AS value FROM "RoleAssignment" a ORDER BY "id"`)).rows,
        grants: (await client.query('SELECT * FROM "WorkcenterGrant" ORDER BY "id"')).rows,
        memberships: (await client.query('SELECT * FROM "WorkspaceMember" ORDER BY "id"')).rows,
        displays: (await client.query('SELECT * FROM "Display" ORDER BY "id"')).rows,
        tokens: (await client.query('SELECT * FROM "DisplayRefreshToken" ORDER BY "id"')).rows,
        comments: (await client.query('SELECT "id", "text", "createdById", "createdAt", "updatedAt", "stationId" FROM "ShiftComment" ORDER BY "id"')).rows,
      });
      const originalState = await protectedState();
      const beforeCli = await runCli(["--json", "--workspace-id", ids.workspace], previewDatabaseUrl);
      expect(beforeCli.status, beforeCli.stderr).toBe(0);
      expect(beforeCli.stderr).toBe("");
      const beforeReport = JSON.parse(beforeCli.stdout) as PermissionMigrationPreview & { databaseReadOnly: boolean };
      expect(beforeReport.databaseReadOnly).toBe(true);
      expect(beforeReport.summary.claimedDisplays).toBe(3);
      expect(beforeReport.displays.missingBootstrap.ids).toEqual([ids.missingBootstrapDisplay]);
      expect(beforeReport.roles.every((r) => r.schemaState === "PRE_UPGRADE")).toBe(true);
      expect(beforeReport.roles.some((r) => r.workspaceId === ids.otherWorkspace)).toBe(false);
      expect(beforeCli.stdout).not.toMatch(/fixture-.*do-not-print|bootstrapSecretHash|tokenHash/);
      expect(await protectedState()).toEqual(originalState);

      await migrate();
      const migratedRoles = (await client.query<MigrationRoleRow>('SELECT * FROM "Role" ORDER BY "id"')).rows;
      for (const original of originalRoles) {
        const migrated = migratedRoles.find((r) => r.id === original.id)!;
        expect(migrated).toBeDefined();
        expect(migrated.legacyPermissions).toEqual(original.permissions);
        expect(migrated.workspaceId).toBe(original.workspaceId);
        expect(migrated.scope).toBe(original.scope);
        expect(migrated.isSystem).toBe(original.isSystem);
        const spec = SYSTEM_ROLE_SPECS.find((s) => s.name === original.name && s.scope === original.scope);
        const expected = original.isSystem ? spec?.permissions ?? original.permissions
          : mapLegacyCustomPermissions(original.permissions, original.scope).permissions;
        expect(migrated.permissions).toEqual(expected);
      }
      expect(migratedRoles.find((r) => r.id === ids.plannerCustom)?.permissions).toEqual(["planning:read", "planning:write"]);
      expect(migratedRoles.find((r) => r.id === ids.readCustom)?.permissions).toEqual(["production:read", "planning:read", "configuration:read"]);
      expect(migratedRoles.find((r) => r.id === ids.configurationCustom)?.permissions).toEqual(["configuration:read", "configuration:write"]);
      expect(migratedRoles.find((r) => r.id === ids.plantCustom)?.permissions).toEqual(["plant:admin"]);
      expect(migratedRoles.find((r) => r.id === ids.partialCustom)?.permissions).toEqual([]);
      expect(migratedRoles.find((r) => r.id === ids.collision)).toMatchObject({ name: "Planner", isSystem: false, permissions: ["planning:read"] });
      expect(migratedRoles.filter((r) => r.workspaceId === ids.workspace && r.name === "Planner")).toHaveLength(1);
      expect(migratedRoles.find((r) => r.workspaceId === ids.workspace && r.name === "Plant Engineer"))
        .toMatchObject({ isSystem: true, legacyPermissions: null, permissions: ["production:admin", "planning:write", "configuration:write"] });
      expect(await protectedState()).toEqual(originalState);
      expect((await client.query('SELECT "workcenterId" FROM "RoleAssignment"')).rows.every((r) => r.workcenterId === null)).toBe(true);

      // The enum migration is committed: these inserts exercise the actual new
      // scope and FK without unsafe-new-enum-value errors inside its transaction.
      await client.query(`INSERT INTO "Role" ("id", "workspaceId", "name", "scope", "permissions", "isSystem")
        VALUES ($1, $2, 'WC supervisor', 'WORKCENTER', ARRAY['production:admin'], false)`, [ids.workcenterRole, ids.workspace]);
      await client.query(`INSERT INTO "RoleAssignment" ("id", "membershipId", "roleId", "siteId", "workcenterId")
        VALUES ($1, $2, $3, $4, $5)`, [ids.workcenterAssignment, ids.membership, ids.workcenterRole, ids.site, ids.workcenter]);
      expect(await rejectedMigrationQuery(client, `INSERT INTO "RoleAssignment" ("id", "membershipId", "roleId", "workcenterId")
        VALUES ($1, $2, $3, $4)`, [randomUUID(), ids.membership, ids.workcenterRole, ids.workcenter])).toBe("23514");

      const beforeSecondCli = await protectedState();
      const rolesBeforeSecondCli = (await client.query('SELECT * FROM "Role" ORDER BY "id"')).rows;
      const afterCli = await runCli(["--json", "--workspace-id", ids.workspace], previewDatabaseUrl);
      expect(afterCli.status, afterCli.stderr).toBe(0);
      const afterReport = JSON.parse(afterCli.stdout) as PermissionMigrationPreview & { databaseReadOnly: boolean };
      expect(afterReport.databaseReadOnly).toBe(true);
      expect(afterReport.roles.find((r) => r.id === ids.plannerCustom))
        .toMatchObject({ source: "MIGRATION_BACKUP", differsFromStored: false, originalPermissions: originalRoles.find((r) => r.id === ids.plannerCustom)!.permissions });
      expect(afterReport.roles.find((r) => r.id === ids.workcenterRole)?.assignments[0])
        .toMatchObject({ scope: "WORKCENTER", workcenterId: ids.workcenter, membershipId: ids.membership, scopeMismatch: false });
      expect(afterReport.workcenterGrants.find((g) => g.id === ids.writeGrant))
        .toMatchObject({ access: "WRITE", proposedAccess: "WRITE", promotedToEngineer: false, removedSiteGlobalWrites: expect.arrayContaining(["graph:write", "job:write"]) });
      expect(afterCli.stdout).not.toMatch(/fixture-.*do-not-print|bootstrapSecretHash|tokenHash/);
      expect(await protectedState()).toEqual(beforeSecondCli);
      expect((await client.query('SELECT * FROM "Role" ORDER BY "id"')).rows).toEqual(rolesBeforeSecondCli);
      const human = await runCli(["--workspace-id", ids.workspace], previewDatabaseUrl);
      expect(human.status, human.stderr).toBe(0);
      expect(human.stdout).toContain("Permission migration preview (read only)");
      expect(human.stdout).not.toMatch(/fixture-.*do-not-print|bootstrapSecretHash|tokenHash/);

      const comments = (await client.query('SELECT * FROM "ShiftComment"')).rows;
      expect(comments.find((c) => c.id === ids.userComment)).toMatchObject({
        authorKind: "USER", authorId: ids.user, createdById: ids.user,
        authorAssurance: null, authorEmployeeId: null, authorEmployeeVersionId: null, operatorSessionId: null,
      });
      expect(comments.find((c) => c.id === ids.unknownComment)).toMatchObject({ authorKind: "UNKNOWN", authorId: null, authorAssurance: null });
      for (const [field, value] of [
        ["authorId", ids.otherUser], ["authorEmployeeId", ids.employee], ["operatorSessionId", randomUUID()],
        ["authorEmployeeVersionId", randomUUID()], ["authorAssurance", "VERIFIED"],
      ]) {
        expect(await rejectedMigrationQuery(client, `UPDATE "ShiftComment" SET "${field}" = $1 WHERE "id" = $2`, [value, ids.userComment])).toBe("P0001");
      }
      expect(await rejectedMigrationQuery(client, `UPDATE "ShiftComment" SET "authorKind" = 'USER', "authorId" = $1 WHERE "id" = $2`, [ids.user, ids.unknownComment])).toBe("P0001");
      await client.query(`INSERT INTO "ShiftComment" ("id", "siteId", "workcenterId", "text", "authorKind", "authorId", "authorEmployeeId", "authorAssurance")
        VALUES ($1, $2, $3, 'Identified fixture author', 'EMPLOYEE', $4, $4, 'IDENTIFIED')`,
        [ids.employeeComment, ids.site, ids.workcenter, ids.employee]);
      expect(await rejectedMigrationQuery(client, 'UPDATE "ShiftComment" SET "authorEmployeeId" = $1 WHERE "id" = $2', [ids.otherEmployee, ids.employeeComment])).toBe("P0001");
      await client.query('DELETE FROM "Employee" WHERE "id" = $1', [ids.employee]);
      expect((await client.query('SELECT "authorId", "authorEmployeeId", "authorAssurance" FROM "ShiftComment" WHERE "id" = $1', [ids.employeeComment])).rows[0])
        .toEqual({ authorId: ids.employee, authorEmployeeId: null, authorAssurance: "IDENTIFIED" });

      expect((await client.query(`SELECT confdeltype FROM pg_constraint
        WHERE conrelid = '"Display"'::regclass AND conname = 'Display_stationId_fkey'`)).rows[0].confdeltype).toBe("r");
      // PostgreSQL can report either restrict_violation or foreign_key_violation.
      expect(["23001", "23503"]).toContain(await rejectedMigrationQuery(client, 'DELETE FROM "Station" WHERE "id" = $1', [ids.station]));
      expect((await client.query('SELECT "stationId" FROM "Display" WHERE "id" = $1', [ids.fixedDisplay])).rows[0].stationId).toBe(ids.station);
      expect((await client.query('SELECT * FROM "DisplayRefreshToken" ORDER BY "id"')).rows).toEqual(originalState.tokens);
    });
  }, 60_000);
});

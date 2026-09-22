import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@rw/db", () => ({ default: {} }));

import {
  ACTIONS,
  CUSTOMER_PERMISSIONS,
  LEGACY_CUSTOM_PERMISSION_CATALOG,
  LEGACY_PERMISSION_MIGRATION_RULES,
  type LegacyPermissionMigrationRule,
  type Permission,
  type PermissionRoleScope,
  getLegacyPermissionMigrationRequirements,
  mapLegacyCustomPermissions,
  snapshotHasPermission,
} from "./permissions.js";

const bundle = (resources: string[], actions: readonly string[] = ACTIONS) =>
  resources.flatMap((resource) => actions.map((action) => `${resource}:${action}`));
const ruleFor = (permission: Permission) => {
  const rule = LEGACY_PERMISSION_MIGRATION_RULES.find((r) => r.permission === permission);
  if (!rule) throw new Error(`Missing migration rule: ${permission}`);
  return rule;
};
const productionReads = bundle(
  [
    "facility",
    "job",
    "status",
    "calls",
    "modes",
    "tool",
    "product",
    "schedule",
    "dashboard",
    "employee",
    "graph",
    "entity",
  ],
  ["read"],
);
const configurationResources = [
  "facility",
  "job",
  "status",
  "calls",
  "modes",
  "notifications",
  "dashboard",
  "entity",
  "graph",
  "settings",
];

describe("complete responsibility bundles", () => {
  it("preserves a complete old job/schedule role as Planner without assigning operational administration", () => {
    const delta = mapLegacyCustomPermissions(bundle(["job", "schedule"]));
    expect(delta.permissions).toEqual(["planning:read", "planning:write"]);
    expect(delta.addedPermissions).toEqual(delta.permissions);
    expect(delta.rulesApplied).toEqual(delta.permissions);
    expect(delta.unmappedPermissions).toEqual([]);
    // job:write also used to grant production/catalog writes: being a mapping
    // prerequisite is not proof that every old responsibility was preserved.
    expect(delta.requiresReview).toBe(true);
    expect(delta.requirements.find((r) => r.permission === "production:write")?.granted).toBe(false);
  });

  it("preserves complete read roles without synthesizing any write or admin capability", () => {
    const reads = LEGACY_CUSTOM_PERMISSION_CATALOG.filter((p) => p.endsWith(":read"));
    const delta = mapLegacyCustomPermissions(reads);
    expect(delta.permissions).toEqual(["production:read", "planning:read", "configuration:read"]);
    expect(delta.effectivePermissions).toEqual(delta.permissions);
    expect(delta.unmappedPermissions).toEqual(["user:read", "billing:read"]);
    expect(delta.requiresReview).toBe(true);
  });

  it("requires both planning read entrances, and both old delete gates for planning writes", () => {
    expect(mapLegacyCustomPermissions(["job:read"]).permissions).toEqual([]);
    expect(mapLegacyCustomPermissions(["schedule:read"]).permissions).toEqual([]);
    expect(mapLegacyCustomPermissions(["job:read", "schedule:read"]).permissions).toEqual(["planning:read"]);
    for (const missing of ["job:read", "schedule:read", "job:admin", "schedule:admin"]) {
      const input = bundle(["job", "schedule"]).filter((p) => p !== missing);
      expect(mapLegacyCustomPermissions(input).permissions).not.toContain("planning:write");
    }
  });

  it("requires graph/entity and supporting read entrances before mapping production reads", () => {
    expect(mapLegacyCustomPermissions(productionReads).permissions).toContain("production:read");
    for (const missing of [
      "graph:read",
      "entity:read",
      "tool:read",
      "product:read",
      "schedule:read",
      "dashboard:read",
    ]) {
      expect(mapLegacyCustomPermissions(productionReads.filter((p) => p !== missing)).permissions).not.toContain(
        "production:read",
      );
    }
  });

  it("requires legacy product and document admin gates now covered by production writes", () => {
    const input = [
      ...productionReads,
      "facility:write",
      "facility:admin",
      "job:write",
      "status:write",
      "calls:write",
      "modes:write",
      "tool:write",
      "product:write",
      "product:admin",
      "schedule:write",
    ];
    expect(mapLegacyCustomPermissions(input).permissions).toEqual([
      "production:read",
      "production:write",
      "planning:read",
    ]);
    for (const missing of ["product:admin", "facility:admin", "status:write", "schedule:write", "graph:read"]) {
      expect(mapLegacyCustomPermissions(input.filter((p) => p !== missing)).permissions).not.toContain(
        "production:write",
      );
    }
  });

  it("preserves a complete configuration composite and rejects missing old administrative gates", () => {
    const input = bundle(configurationResources);
    expect(mapLegacyCustomPermissions(input).permissions).toEqual(["configuration:read", "configuration:write"]);
    for (const missing of ["settings:admin", "notifications:admin", "modes:admin", "job:admin", "facility:read"]) {
      expect(mapLegacyCustomPermissions(input.filter((p) => p !== missing)).permissions).not.toContain(
        "configuration:write",
      );
    }
    expect(mapLegacyCustomPermissions(bundle(configurationResources, ["read"])).permissions).toEqual([
      "configuration:read",
    ]);
  });

  it.each([
    "SITE",
    "WORKSPACE",
  ] as const)("keeps complete user/employee/settings administration at %s scope", (scope) => {
    const delta = mapLegacyCustomPermissions(bundle(["user", "employee", "settings"]), scope);
    expect(delta.permissions).toEqual(["plant:admin"]);
    const snapshot = {
      systemRole: null,
      assignments: [{ siteId: scope === "SITE" ? "site-a" : null, permissions: delta.permissions }],
    };
    expect(snapshotHasPermission(snapshot, "plant:admin", "site-a")).toBe(true);
    expect(snapshotHasPermission(snapshot, "plant:admin", "site-b")).toBe(scope === "WORKSPACE");
    expect(snapshotHasPermission(snapshot, "plant:admin")).toBe(scope === "WORKSPACE");
    expect(snapshotHasPermission(snapshot, "production:read", "site-a")).toBe(false);
    expect(snapshotHasPermission(snapshot, "owner:all")).toBe(false);
  });

  it("requires a truly full legacy catalog for production admin, not calls/modes administration", () => {
    expect(mapLegacyCustomPermissions(bundle(["calls", "modes"])).permissions).not.toContain("production:admin");
    expect(mapLegacyCustomPermissions(LEGACY_CUSTOM_PERMISSION_CATALOG).permissions).toEqual(CUSTOMER_PERMISSIONS);
    expect(
      mapLegacyCustomPermissions(LEGACY_CUSTOM_PERMISSION_CATALOG.filter((p) => p !== "billing:read")).permissions,
    ).not.toContain("production:admin");
    expect(mapLegacyCustomPermissions(["production:admin"]).effectivePermissions).toEqual([
      "production:admin",
      "production:write",
      "production:read",
    ]);
  });
});

describe("scope, implication and preview evidence", () => {
  it.each(LEGACY_PERMISSION_MIGRATION_RULES)("every prerequisite for $permission is mandatory", (rule) => {
    expect(mapLegacyCustomPermissions(rule.requiredPermissions).permissions).toContain(rule.permission);
    for (const missing of rule.requiredPermissions) {
      const input = rule.requiredPermissions.filter((p) => p !== missing);
      expect(
        mapLegacyCustomPermissions(input).effectivePermissions,
        `${rule.permission} without ${missing}`,
      ).not.toContain(rule.permission);
    }
  });

  it("does not infer legacy reads from writes/admins or treat already-new reads as legacy prerequisites", () => {
    const input = ["job:write", "job:admin", "schedule:write", "schedule:admin", "planning:read"];
    expect(mapLegacyCustomPermissions(input).permissions).toEqual(["planning:read"]);
    const requirement = getLegacyPermissionMigrationRequirements(input).find((r) => r.permission === "planning:write");
    expect(requirement).toMatchObject({
      missingPermissions: ["job:read", "schedule:read"],
      scopeAllowed: true,
      legacySatisfied: false,
      retained: false,
      granted: false,
    });
  });

  it("cannot pool incomplete grants across separate roles even at the same site", () => {
    const assignments = ["job:read", "schedule:read"].map((p) => ({
      siteId: "site-a",
      permissions: mapLegacyCustomPermissions([p]).permissions,
    }));
    expect(snapshotHasPermission({ systemRole: null, assignments }, "planning:read", "site-a")).toBe(false);
  });

  it("workcenter roles remain production-only, including explicit invalid scope keys", () => {
    const delta = mapLegacyCustomPermissions(
      [...LEGACY_CUSTOM_PERMISSION_CATALOG, "plant:admin", "owner:all"],
      "WORKCENTER",
    );
    expect(delta.permissions).toEqual(["production:read", "production:write", "production:admin"]);
    expect(delta.requirements.find((r) => r.permission === "plant:admin")).toMatchObject({
      missingPermissions: [],
      scopeAllowed: false,
      legacySatisfied: false,
      retained: false,
      granted: false,
    });
    expect(delta.unmappedPermissions).toEqual(["plant:admin", "owner:all"]);
    expect(delta.requiresReview).toBe(true);
    const assignments = [{ siteId: "site-a", workcenterId: "wc-a", permissions: delta.permissions }];
    expect(snapshotHasPermission({ systemRole: null, assignments }, "production:read", "site-a", "wc-a")).toBe(true);
    expect(snapshotHasPermission({ systemRole: null, assignments }, "production:read", "site-a", "wc-b")).toBe(false);
    expect(snapshotHasPermission({ systemRole: null, assignments }, "production:read", "site-a")).toBe(false);
  });

  it("preserves exact originals and reports retained, added, removed, and unmapped strings separately", () => {
    const input = Object.freeze([
      "job:read",
      "planning:read",
      "schedule:read",
      "job:read",
      "billing:read",
      "owner:all",
      "typo",
    ]);
    const delta = mapLegacyCustomPermissions(input);
    expect(delta.originalPermissions).toEqual(input);
    expect(delta.originalPermissions).not.toBe(input);
    expect(delta.retainedPermissions).toEqual(["planning:read"]);
    expect(delta.addedPermissions).toEqual([]);
    expect(delta.droppedPermissions).toEqual(["job:read", "schedule:read", "billing:read", "owner:all", "typo"]);
    expect(delta.unmappedPermissions).toEqual(["billing:read", "owner:all", "typo"]);
    expect(delta.rulesApplied).toEqual(["planning:read"]);
    expect(delta.requiresReview).toBe(true);
    expect(mapLegacyCustomPermissions(["planning:write"]).requiresReview).toBe(false);
    expect(mapLegacyCustomPermissions([]).requiresReview).toBe(false);
  });

  it("returned preview arrays cannot mutate requirement metadata or another preview", () => {
    const preview = getLegacyPermissionMigrationRequirements([]);
    const planning = preview.find((r) => r.permission === "planning:read")!;
    planning.missingPermissions.pop();
    expect(
      getLegacyPermissionMigrationRequirements([]).find((r) => r.permission === "planning:read")?.missingPermissions,
    ).toEqual(["job:read", "schedule:read"]);
    expect(planning.requiredPermissions).not.toBe(ruleFor("planning:read").requiredPermissions);
  });
});

describe("executable SQL rule parity", () => {
  const sql = readFileSync(
    new URL("../../../db/migrations/20260923000000_simplify_permissions/migration.sql", import.meta.url),
    "utf8",
  );
  const match = sql.match(/\$permission_rules\$([\s\S]*?)\$permission_rules\$/);
  if (!match) throw new Error("Migration must contain executable permission_rules JSON");
  const sqlRules = JSON.parse(match[1]) as Array<Omit<LegacyPermissionMigrationRule, "explanation">>;

  it("uses the exact same ordered requirements and scope restrictions as the preview helper", () => {
    expect(sqlRules).toEqual(LEGACY_PERMISSION_MIGRATION_RULES.map(({ explanation: _explanation, ...rule }) => rule));
    expect(sqlRules.map((r) => r.permission)).toEqual(CUSTOMER_PERMISSIONS);
    expect(sql).toContain('r."permissions" @> rule."requiredPermissions"');
    expect(sql).toContain('r."scope"::text = ANY(rule."allowedScopes")');
    expect(sql).toContain('WHERE r."isSystem" = false');
    expect(sql.indexOf('to_jsonb("permissions")')).toBeLessThan(sql.indexOf("$permission_rules$"));
  });

  it.each([
    "SITE",
    "WORKSPACE",
    "WORKCENTER",
  ] as const)("SQL declaration preserves implication prerequisites at %s scope", (scope: PermissionRoleScope) => {
    for (const rule of sqlRules.filter((r) => r.allowedScopes.includes(scope))) {
      const impliedRead = rule.permission.endsWith(":write") ? rule.permission.replace(":write", ":read") : undefined;
      if (!impliedRead) continue;
      const readRule = sqlRules.find((r) => r.permission === impliedRead)!;
      expect(rule.requiredPermissions).toEqual(expect.arrayContaining([...readRule.requiredPermissions]));
    }
  });
});

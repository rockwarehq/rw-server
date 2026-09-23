import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, CUSTOMER_PERMISSIONS, LEGACY_PERMISSION_RULES, isPermission } from "./permissions.js";

// The expand migration embeds LEGACY_PERMISSION_RULES verbatim as JSON. These
// tests keep the two copies identical and pin the semantics of the rules.

const MIGRATION_SQL = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations/20260922190000_expand_permission_vocabulary/migration.sql",
);

const CUSTOMER_SET = new Set<string>(CUSTOMER_PERMISSIONS);
const LEGACY_KEYS = ALL_PERMISSIONS.filter((p) => !CUSTOMER_SET.has(p) && p !== "owner:all");

function rulesFromSql(): Array<{ permission: string; required: string[] }> {
  const sql = readFileSync(MIGRATION_SQL, "utf8");
  const match = sql.match(/\$rules\$([\s\S]*?)\$rules\$/);
  if (!match) throw new Error("expand migration: $rules$ block not found");
  return JSON.parse(match[1]);
}

/** What the SQL's rule application does, in plain JS. */
function expandArray(permissions: readonly string[]): string[] {
  const held = new Set(permissions);
  const additions = LEGACY_PERMISSION_RULES.filter(
    (rule) => !held.has(rule.permission) && rule.requiredPermissions.every((p) => held.has(p)),
  ).map((rule) => rule.permission);
  return [...permissions, ...additions];
}

describe("expand migration ↔ code parity", () => {
  it("the SQL's embedded rules match LEGACY_PERMISSION_RULES exactly", () => {
    const fromSql = rulesFromSql();
    const fromCode = LEGACY_PERMISSION_RULES.map((rule) => ({
      permission: rule.permission,
      required: [...rule.requiredPermissions],
    }));
    expect(fromSql).toEqual(fromCode);
  });
});

describe("rule invariants", () => {
  it("covers each of the eight new keys exactly once", () => {
    expect(LEGACY_PERMISSION_RULES.map((r) => r.permission).sort()).toEqual([...CUSTOMER_PERMISSIONS].sort());
  });

  it("required bundles contain only valid LEGACY keys, no duplicates", () => {
    for (const rule of LEGACY_PERMISSION_RULES) {
      for (const p of rule.requiredPermissions) {
        expect(isPermission(p), `${p} in ${rule.permission}`).toBe(true);
        expect(CUSTOMER_SET.has(p), `${p} must be legacy`).toBe(false);
        expect(p).not.toBe("owner:all");
      }
      expect(new Set(rule.requiredPermissions).size).toBe(rule.requiredPermissions.length);
    }
  });

  it("planning:write is relaxed: no legacy admin keys required", () => {
    const rule = LEGACY_PERMISSION_RULES.find((r) => r.permission === "planning:write");
    expect(rule?.requiredPermissions.some((p) => p.endsWith(":admin"))).toBe(false);
  });

  it("production:write is strict: the old admin delete gates are required", () => {
    const rule = LEGACY_PERMISSION_RULES.find((r) => r.permission === "production:write");
    expect(rule?.requiredPermissions).toContain("facility:admin");
    expect(rule?.requiredPermissions).toContain("product:admin");
  });

  it("production:admin requires the entire legacy catalog", () => {
    const rule = LEGACY_PERMISSION_RULES.find((r) => r.permission === "production:admin");
    expect([...(rule?.requiredPermissions ?? [])].sort()).toEqual([...LEGACY_KEYS].sort());
  });
});

describe("what the expansion does to real arrays", () => {
  // The legacy seeded bundles as they exist in customer DB rows today.
  const LEGACY_MEMBER = [
    "facility:read",
    "product:read",
    "job:read",
    "status:read",
    "calls:read",
    "modes:read",
    "notifications:read",
    "tool:read",
    "schedule:read",
    "dashboard:read",
    "entity:read",
    "graph:read",
    "employee:read",
  ];

  it("a full legacy read bundle earns production:read and planning:read only", () => {
    const out = expandArray(LEGACY_MEMBER);
    const added = out.filter((p) => CUSTOMER_SET.has(p));
    expect(added.sort()).toEqual(["planning:read", "production:read"]);
    // Nothing is removed.
    for (const p of LEGACY_MEMBER) expect(out).toContain(p);
  });

  it("the full legacy catalog earns all eight keys", () => {
    const out = expandArray(LEGACY_KEYS);
    for (const p of CUSTOMER_PERMISSIONS) expect(out).toContain(p);
  });

  it("a partial bundle earns nothing (one missing read blocks production:read)", () => {
    const out = expandArray(LEGACY_MEMBER.filter((p) => p !== "entity:read"));
    expect(out.filter((p) => p === "production:read")).toEqual([]);
    // planning:read still earned: job:read + schedule:read are both present.
    expect(out).toContain("planning:read");
  });

  it("a plain writer role earns planning:write without the old admin keys", () => {
    const out = expandArray(["job:read", "job:write", "schedule:read", "schedule:write"]);
    expect(out).toContain("planning:write");
    expect(out).toContain("planning:read");
    expect(out).not.toContain("production:write");
  });

  it("already-present new keys are not duplicated", () => {
    const out = expandArray(["job:read", "schedule:read", "planning:read"]);
    expect(out.filter((p) => p === "planning:read")).toHaveLength(1);
  });
});

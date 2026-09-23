import { describe, expect, it } from "vitest";
import {
  CUSTOMER_PERMISSIONS,
  type PermissionSnapshot,
  SYSTEM_ROLE_PERMISSIONS,
  expandPermissions,
  snapshotAccessibleSites,
  snapshotEffectivePermissions,
  snapshotHasPermission,
  snapshotVisibleSites,
  snapshotWorkcentersWithPermission,
} from "./permissions.js";

const SITE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SITE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WC_1 = "11111111-1111-4111-8111-111111111111";
const WC_2 = "22222222-2222-4222-8222-222222222222";

const snap = (
  assignments: PermissionSnapshot["assignments"],
  systemRole: string | null = null,
  workcenterGrants?: PermissionSnapshot["workcenterGrants"],
  grantsRequiredSiteIds?: string[],
): PermissionSnapshot => ({
  systemRole,
  assignments,
  ...(workcenterGrants ? { workcenterGrants } : {}),
  ...(grantsRequiredSiteIds ? { grantsRequiredSiteIds } : {}),
});

describe("expandPermissions (implication closure)", () => {
  it("closes admin → write → read transitively in one call", () => {
    expect(expandPermissions(["production:admin"])).toEqual(
      new Set(["production:admin", "production:write", "production:read"]),
    );
  });

  it("write implies read within each group", () => {
    expect(expandPermissions(["planning:write"])).toEqual(new Set(["planning:write", "planning:read"]));
    expect(expandPermissions(["configuration:write"])).toEqual(new Set(["configuration:write", "configuration:read"]));
  });

  it("plant:admin and owner:all are not wildcards", () => {
    expect(expandPermissions(["plant:admin"])).toEqual(new Set(["plant:admin"]));
    expect(expandPermissions(["owner:all"])).toEqual(new Set(["owner:all"]));
  });

  it("unknown and retired strings are dropped", () => {
    expect(expandPermissions(["job:write", "bogus:verb", "planning:read"])).toEqual(new Set(["planning:read"]));
  });
});

describe("snapshotEffectivePermissions", () => {
  it("unions workspace-level and matching site-level assignments", () => {
    const s = snap([
      { siteId: null, permissions: ["planning:read"] },
      { siteId: SITE_A, permissions: ["production:write"] },
      { siteId: SITE_B, permissions: ["configuration:write"] },
    ]);
    expect(snapshotEffectivePermissions(s, SITE_A)).toEqual(
      new Set(["planning:read", "production:write", "production:read"]),
    );
  });

  it("includes only workspace-level assignments when no site context is given", () => {
    const s = snap([
      { siteId: null, permissions: ["planning:read"] },
      { siteId: SITE_A, permissions: ["production:write"] },
    ]);
    expect(snapshotEffectivePermissions(s)).toEqual(new Set(["planning:read"]));
  });

  it("silently drops unknown and retired permission strings", () => {
    const s = snap([{ siteId: null, permissions: ["planning:read", "facility:read", "not-a-permission"] }]);
    expect(snapshotEffectivePermissions(s)).toEqual(new Set(["planning:read"]));
  });

  it("resolves system roles from code, ignoring assignments", () => {
    const support = snapshotEffectivePermissions(snap([{ siteId: null, permissions: ["plant:admin"] }], "SUPPORT"));
    expect(support.has("production:read")).toBe(true);
    expect(support.has("planning:read")).toBe(true);
    expect(support.has("configuration:read")).toBe(true);
    expect(support.has("production:write")).toBe(false);
    expect(support.has("plant:admin")).toBe(false);

    const engineer = snapshotEffectivePermissions(snap([], "ENGINEER"));
    for (const p of CUSTOMER_PERMISSIONS) expect(engineer.has(p)).toBe(true);
    expect(engineer.has("owner:all")).toBe(false);
  });

  it("returns an empty set for an unknown system role string", () => {
    expect(snapshotEffectivePermissions(snap([], "NOT_A_ROLE"))).toEqual(new Set());
  });
});

describe("snapshotHasPermission", () => {
  it("is site-sensitive", () => {
    const s = snap([{ siteId: SITE_A, permissions: ["planning:write"] }]);
    expect(snapshotHasPermission(s, "planning:write", SITE_A)).toBe(true);
    expect(snapshotHasPermission(s, "planning:write", SITE_B)).toBe(false);
    expect(snapshotHasPermission(s, "planning:write")).toBe(false);
  });

  it("honors implication: production:admin satisfies write and read checks", () => {
    const s = snap([{ siteId: SITE_A, permissions: ["production:admin"] }]);
    expect(snapshotHasPermission(s, "production:write", SITE_A)).toBe(true);
    expect(snapshotHasPermission(s, "production:read", SITE_A)).toBe(true);
    expect(snapshotHasPermission(s, "plant:admin", SITE_A)).toBe(false);
  });
});

describe("snapshotAccessibleSites", () => {
  it("returns all:true when a workspace-level assignment grants the permission", () => {
    const s = snap([
      { siteId: SITE_A, permissions: ["planning:read"] },
      { siteId: null, permissions: ["planning:read"] },
    ]);
    expect(snapshotAccessibleSites(s, "planning:read")).toEqual({ all: true });
  });

  it("collects only the sites whose assignments grant the permission, implied keys included", () => {
    const s = snap([
      { siteId: SITE_A, permissions: ["planning:write"] },
      { siteId: SITE_B, permissions: ["planning:read"] },
    ]);
    expect(snapshotAccessibleSites(s, "planning:write")).toEqual({ all: false, siteIds: [SITE_A] });
    const implied = snapshotAccessibleSites(s, "planning:read");
    expect(implied.all).toBe(false);
    if (!implied.all) expect(new Set(implied.siteIds)).toEqual(new Set([SITE_A, SITE_B]));
  });

  it("fails closed with no matching assignments", () => {
    expect(snapshotAccessibleSites(snap([]), "planning:read")).toEqual({ all: false, siteIds: [] });
  });

  it("resolves system roles: all sites when the role carries the permission, none otherwise", () => {
    expect(snapshotAccessibleSites(snap([], "SUPPORT"), "production:read")).toEqual({ all: true });
    expect(snapshotAccessibleSites(snap([], "SUPPORT"), "production:write")).toEqual({ all: false, siteIds: [] });
  });
});

describe("workcenter grants", () => {
  const readGrant = { workcenterId: WC_1, siteId: SITE_A, access: "READ" };
  const writeGrant = { workcenterId: WC_1, siteId: SITE_A, access: "WRITE" };

  it("READ confers production:read at the granted workcenter only — nothing site-wide", () => {
    const s = snap([], null, [readGrant]);
    expect(snapshotHasPermission(s, "production:read", SITE_A, WC_1)).toBe(true);
    expect(snapshotHasPermission(s, "production:read", SITE_A, WC_2)).toBe(false);
    expect(snapshotHasPermission(s, "production:read", SITE_A)).toBe(false);
    expect(snapshotHasPermission(s, "production:write", SITE_A, WC_1)).toBe(false);
    expect(snapshotEffectivePermissions(s, SITE_B).size).toBe(0);
    expect(snapshotEffectivePermissions(s).size).toBe(0);
  });

  it("WRITE confers production:write at the granted workcenter, never wider authority", () => {
    const s = snap([], null, [writeGrant]);
    expect(snapshotHasPermission(s, "production:write", SITE_A, WC_1)).toBe(true);
    expect(snapshotHasPermission(s, "production:read", SITE_A, WC_1)).toBe(true);
    expect(snapshotHasPermission(s, "production:write", SITE_A, WC_2)).toBe(false);
    expect(snapshotHasPermission(s, "production:admin", SITE_A, WC_1)).toBe(false);
    expect(snapshotHasPermission(s, "planning:read", SITE_A)).toBe(false);
    expect(snapshotHasPermission(s, "configuration:read", SITE_A, WC_1)).toBe(false);
    expect(snapshotHasPermission(s, "plant:admin", SITE_A, WC_1)).toBe(false);
  });

  it("site role and grant union — the site role dominates at every workcenter", () => {
    const s = snap([{ siteId: SITE_A, permissions: ["production:write", "plant:admin"] }], null, [readGrant]);
    expect(snapshotHasPermission(s, "production:write", SITE_A, WC_2)).toBe(true);
    expect(snapshotHasPermission(s, "plant:admin", SITE_A)).toBe(true);
  });

  it("unknown access levels confer nothing", () => {
    const s = snap([], null, [{ workcenterId: WC_1, siteId: SITE_A, access: "OWNER" }]);
    expect(snapshotEffectivePermissions(s, SITE_A, WC_1).size).toBe(0);
  });

  it("snapshotAccessibleSites counts grant sites for grant-conferred permissions", () => {
    const s = snap([], null, [writeGrant]);
    expect(snapshotAccessibleSites(s, "production:read")).toEqual({ all: false, siteIds: [SITE_A] });
    expect(snapshotAccessibleSites(s, "production:write")).toEqual({ all: false, siteIds: [SITE_A] });
    expect(snapshotAccessibleSites(s, "configuration:read")).toEqual({ all: false, siteIds: [] });
  });

  it("snapshotWorkcentersWithPermission lists granted workcenters at the site", () => {
    const s = snap([], null, [writeGrant, { workcenterId: WC_2, siteId: SITE_B, access: "WRITE" }]);
    expect(snapshotWorkcentersWithPermission(s, "production:write", SITE_A)).toEqual([WC_1]);
    expect(snapshotWorkcentersWithPermission(s, "production:write", SITE_B)).toEqual([WC_2]);
    const readOnly = snap([], null, [readGrant]);
    expect(snapshotWorkcentersWithPermission(readOnly, "production:write", SITE_A)).toEqual([]);
    expect(snapshotWorkcentersWithPermission(readOnly, "production:read", SITE_A)).toEqual([WC_1]);
  });
});

describe("base workcenter access policy (GRANTS_REQUIRED)", () => {
  it("strips production:read from read-tier site roles, keeping everything else", () => {
    const s = snap([{ siteId: SITE_A, permissions: ["production:read", "planning:read"] }], null, undefined, [SITE_A]);
    const perms = snapshotEffectivePermissions(s, SITE_A);
    expect(perms.has("production:read")).toBe(false);
    expect(perms.has("planning:read")).toBe(true);
  });

  it("exempts management-tier roles (production:write or production:admin present)", () => {
    const writer = snap([{ siteId: SITE_A, permissions: ["production:write"] }], null, undefined, [SITE_A]);
    expect(snapshotHasPermission(writer, "production:read", SITE_A)).toBe(true);
    const admin = snap([{ siteId: SITE_A, permissions: ["production:admin"] }], null, undefined, [SITE_A]);
    expect(snapshotHasPermission(admin, "production:read", SITE_A)).toBe(true);
  });

  it("exempts WORKSPACE-scope roles even when every site is strict", () => {
    const s = snap([{ siteId: null, permissions: ["production:read"] }], null, undefined, [SITE_A, SITE_B]);
    expect(snapshotHasPermission(s, "production:read", SITE_A)).toBe(true);
  });

  it("grants re-add production:read only at the granted workcenter", () => {
    const s = snap(
      [{ siteId: SITE_A, permissions: ["production:read"] }],
      null,
      [{ workcenterId: WC_1, siteId: SITE_A, access: "READ" }],
      [SITE_A],
    );
    expect(snapshotHasPermission(s, "production:read", SITE_A)).toBe(false);
    expect(snapshotHasPermission(s, "production:read", SITE_A, WC_2)).toBe(false);
    expect(snapshotHasPermission(s, "production:read", SITE_A, WC_1)).toBe(true);
  });

  it("applies per site in multi-site snapshots", () => {
    const s = snap(
      [
        { siteId: SITE_A, permissions: ["production:read"] },
        { siteId: SITE_B, permissions: ["production:read"] },
      ],
      null,
      undefined,
      [SITE_A],
    );
    expect(snapshotHasPermission(s, "production:read", SITE_A)).toBe(false);
    expect(snapshotHasPermission(s, "production:read", SITE_B)).toBe(true);
  });

  it("accessible sites: the floor read excludes strict sites, other keys still include them", () => {
    const s = snap([{ siteId: SITE_A, permissions: ["production:read", "planning:read"] }], null, undefined, [SITE_A]);
    expect(snapshotAccessibleSites(s, "production:read")).toEqual({ all: false, siteIds: [] });
    expect(snapshotAccessibleSites(s, "planning:read")).toEqual({ all: false, siteIds: [SITE_A] });
    // A grant still counts its site for the floor read.
    const withGrant = snap(
      [{ siteId: SITE_A, permissions: ["production:read"] }],
      null,
      [{ workcenterId: WC_1, siteId: SITE_A, access: "READ" }],
      [SITE_A],
    );
    expect(snapshotAccessibleSites(withGrant, "production:read")).toEqual({ all: false, siteIds: [SITE_A] });
  });

  it("absent policy field means ALL everywhere; system roles unaffected", () => {
    const legacy = snap([{ siteId: SITE_A, permissions: ["production:read"] }]);
    expect(snapshotEffectivePermissions(legacy, SITE_A).has("production:read")).toBe(true);
    const support = snapshotEffectivePermissions(snap([], "SUPPORT", undefined, [SITE_A]), SITE_A);
    expect(support.has("production:read")).toBe(true);
  });
});

describe("snapshotVisibleSites", () => {
  it("any workspace-wide assignment makes every site visible", () => {
    expect(snapshotVisibleSites(snap([{ siteId: null, permissions: [] }]))).toEqual({ all: true });
  });

  it("site assignments and grants make their sites visible regardless of permissions", () => {
    const s = snap([{ siteId: SITE_A, permissions: ["planning:read"] }], null, [
      { workcenterId: WC_1, siteId: SITE_B, access: "READ" },
    ]);
    const visible = snapshotVisibleSites(s);
    expect(visible.all).toBe(false);
    if (!visible.all) expect(new Set(visible.siteIds)).toEqual(new Set([SITE_A, SITE_B]));
  });

  it("fails closed with no assignments or grants; system roles see everything", () => {
    expect(snapshotVisibleSites(snap([]))).toEqual({ all: false, siteIds: [] });
    expect(snapshotVisibleSites(snap([], "SUPPORT"))).toEqual({ all: true });
    expect(snapshotVisibleSites(snap([], "NOT_A_ROLE"))).toEqual({ all: false, siteIds: [] });
  });

  it("ignores grants with unknown access levels", () => {
    const s = snap([], null, [{ workcenterId: WC_1, siteId: SITE_A, access: "OWNER" }]);
    expect(snapshotVisibleSites(s)).toEqual({ all: false, siteIds: [] });
  });
});

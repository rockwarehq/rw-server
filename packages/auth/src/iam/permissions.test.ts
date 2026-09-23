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

describe("snapshotEffectivePermissions", () => {
  it("unions workspace-level and matching site-level assignments", () => {
    const s = snap([
      { siteId: null, permissions: ["facility:read"] },
      { siteId: SITE_A, permissions: ["job:write"] },
      { siteId: SITE_B, permissions: ["tool:write"] },
    ]);
    expect(snapshotEffectivePermissions(s, SITE_A)).toEqual(new Set(["facility:read", "job:write"]));
  });

  it("includes only workspace-level assignments when no site context is given", () => {
    const s = snap([
      { siteId: null, permissions: ["facility:read"] },
      { siteId: SITE_A, permissions: ["job:write"] },
    ]);
    expect(snapshotEffectivePermissions(s)).toEqual(new Set(["facility:read"]));
  });

  it("silently drops unknown permission strings", () => {
    const s = snap([{ siteId: null, permissions: ["facility:read", "not-a-permission", "bogus:verb"] }]);
    expect(snapshotEffectivePermissions(s)).toEqual(new Set(["facility:read"]));
  });

  it("resolves system roles from code, ignoring assignments", () => {
    const support = snapshotEffectivePermissions(snap([{ siteId: null, permissions: ["billing:admin"] }], "SUPPORT"));
    expect(support.has("facility:read")).toBe(true);
    expect(support.has("facility:write")).toBe(false);
    expect(support.has("billing:read")).toBe(false);
    expect(support.has("billing:admin")).toBe(false);

    const engineer = snapshotEffectivePermissions(snap([], "ENGINEER"));
    expect(engineer.has("facility:admin")).toBe(true);
    expect(engineer.has("owner:all")).toBe(false);
  });

  it("returns an empty set for an unknown system role string", () => {
    expect(snapshotEffectivePermissions(snap([], "NOT_A_ROLE"))).toEqual(new Set());
  });
});

describe("snapshotHasPermission", () => {
  it("is site-sensitive", () => {
    const s = snap([{ siteId: SITE_A, permissions: ["job:write"] }]);
    expect(snapshotHasPermission(s, "job:write", SITE_A)).toBe(true);
    expect(snapshotHasPermission(s, "job:write", SITE_B)).toBe(false);
    expect(snapshotHasPermission(s, "job:write")).toBe(false);
  });
});

describe("snapshotAccessibleSites", () => {
  it("returns all:true when a workspace-level assignment grants the permission", () => {
    const s = snap([
      { siteId: SITE_A, permissions: ["facility:read"] },
      { siteId: null, permissions: ["facility:read"] },
    ]);
    expect(snapshotAccessibleSites(s, "facility:read")).toEqual({ all: true });
  });

  it("collects only the sites whose assignments grant the permission", () => {
    const s = snap([
      { siteId: SITE_A, permissions: ["facility:read", "job:write"] },
      { siteId: SITE_B, permissions: ["facility:read"] },
    ]);
    expect(snapshotAccessibleSites(s, "job:write")).toEqual({ all: false, siteIds: [SITE_A] });
  });

  it("fails closed with no matching assignments", () => {
    expect(snapshotAccessibleSites(snap([]), "facility:read")).toEqual({ all: false, siteIds: [] });
  });

  it("resolves system roles: all sites when the role carries the permission, none otherwise", () => {
    expect(snapshotAccessibleSites(snap([], "SUPPORT"), "facility:read")).toEqual({ all: true });
    expect(snapshotAccessibleSites(snap([], "SUPPORT"), "facility:write")).toEqual({ all: false, siteIds: [] });
  });
});

describe("workcenter grants", () => {
  const readGrant = { workcenterId: WC_1, siteId: SITE_A, access: "READ" };
  const writeGrant = { workcenterId: WC_1, siteId: SITE_A, access: "WRITE" };

  it("READ grant confers global reads site-wide, nothing at other sites", () => {
    const s = snap([], null, [readGrant]);
    const atSite = snapshotEffectivePermissions(s, SITE_A);
    expect(atSite.has("job:read")).toBe(true);
    expect(atSite.has("facility:read")).toBe(true);
    expect(atSite.has("job:write")).toBe(false);
    expect(atSite.has("settings:read")).toBe(false);
    expect(snapshotEffectivePermissions(s, SITE_B).size).toBe(0);
    expect(snapshotEffectivePermissions(s).size).toBe(0);
  });

  it("READ grant confers scoped reads only at the granted workcenter", () => {
    const s = snap([], null, [readGrant]);
    expect(snapshotHasPermission(s, "status:read", SITE_A)).toBe(false);
    expect(snapshotHasPermission(s, "status:read", SITE_A, WC_2)).toBe(false);
    expect(snapshotHasPermission(s, "status:read", SITE_A, WC_1)).toBe(true);
    expect(snapshotHasPermission(s, "calls:read", SITE_A, WC_1)).toBe(true);
    expect(snapshotHasPermission(s, "status:write", SITE_A, WC_1)).toBe(false);
  });

  it("WRITE grant confers global writes site-wide but workcenter writes only in its workcenter", () => {
    const s = snap([], null, [writeGrant]);
    // Global resources: writable anywhere in the site.
    expect(snapshotHasPermission(s, "job:write", SITE_A)).toBe(true);
    expect(snapshotHasPermission(s, "schedule:write", SITE_A, WC_2)).toBe(true);
    // Employee stays read-only even for WRITE.
    expect(snapshotHasPermission(s, "employee:write", SITE_A, WC_1)).toBe(false);
    // Workcenter-scoped: only at the granted workcenter.
    expect(snapshotHasPermission(s, "status:write", SITE_A, WC_1)).toBe(true);
    expect(snapshotHasPermission(s, "calls:write", SITE_A, WC_1)).toBe(true);
    expect(snapshotHasPermission(s, "modes:write", SITE_A, WC_1)).toBe(true);
    expect(snapshotHasPermission(s, "facility:write", SITE_A, WC_1)).toBe(true);
    expect(snapshotHasPermission(s, "status:write", SITE_A, WC_2)).toBe(false);
    expect(snapshotHasPermission(s, "modes:write", SITE_A, WC_2)).toBe(false);
    expect(snapshotHasPermission(s, "facility:write", SITE_A)).toBe(false);
    // Plant-admin territory is never conferred by a grant.
    expect(snapshotHasPermission(s, "settings:write", SITE_A, WC_1)).toBe(false);
    expect(snapshotHasPermission(s, "user:read", SITE_A, WC_1)).toBe(false);
    expect(snapshotHasPermission(s, "billing:read", SITE_A, WC_1)).toBe(false);
    expect(snapshotHasPermission(s, "notifications:write", SITE_A, WC_1)).toBe(false);
  });

  it("site role and grant union — the site role dominates at every workcenter", () => {
    const s = snap([{ siteId: SITE_A, permissions: ["status:write", "settings:write"] }], null, [readGrant]);
    // Site role applies regardless of workcenter…
    expect(snapshotHasPermission(s, "status:write", SITE_A, WC_2)).toBe(true);
    expect(snapshotHasPermission(s, "settings:write", SITE_A)).toBe(true);
    // …and the grant still adds its global reads.
    expect(snapshotHasPermission(s, "job:read", SITE_A)).toBe(true);
  });

  it("unknown access levels confer nothing", () => {
    const s = snap([], null, [{ workcenterId: WC_1, siteId: SITE_A, access: "OWNER" }]);
    expect(snapshotEffectivePermissions(s, SITE_A, WC_1).size).toBe(0);
  });

  it("snapshotAccessibleSites counts grant sites for both global and scoped permissions", () => {
    const s = snap([], null, [writeGrant]);
    expect(snapshotAccessibleSites(s, "facility:read")).toEqual({ all: false, siteIds: [SITE_A] });
    expect(snapshotAccessibleSites(s, "status:write")).toEqual({ all: false, siteIds: [SITE_A] });
    expect(snapshotAccessibleSites(s, "settings:write")).toEqual({ all: false, siteIds: [] });
  });

  it("snapshotWorkcentersWithPermission lists granted workcenters at the site", () => {
    const s = snap([], null, [writeGrant, { workcenterId: WC_2, siteId: SITE_B, access: "WRITE" }]);
    expect(snapshotWorkcentersWithPermission(s, "status:write", SITE_A)).toEqual([WC_1]);
    expect(snapshotWorkcentersWithPermission(s, "status:write", SITE_B)).toEqual([WC_2]);
    const readOnly = snap([], null, [readGrant]);
    expect(snapshotWorkcentersWithPermission(readOnly, "status:write", SITE_A)).toEqual([]);
    expect(snapshotWorkcentersWithPermission(readOnly, "calls:read", SITE_A)).toEqual([WC_1]);
  });
});

describe("base workcenter access policy (GRANTS_REQUIRED)", () => {
  // Plant Member shape: read-tier site role (no status:write).
  const MEMBER_READS = ["facility:read", "job:read", "status:read", "calls:read", "modes:read", "product:read"];
  // Plant Admin shape: carries status:write, the management-tier marker.
  const ADMIN_PERMS = ["facility:read", "status:read", "status:write", "calls:read", "calls:write"];

  it("strips floor reads from read-tier site roles, keeping everything else", () => {
    const s = snap([{ siteId: SITE_A, permissions: MEMBER_READS }], null, undefined, [SITE_A]);
    const perms = snapshotEffectivePermissions(s, SITE_A);
    expect(perms.has("status:read")).toBe(false);
    expect(perms.has("calls:read")).toBe(false);
    expect(perms.has("modes:read")).toBe(false);
    expect(perms.has("facility:read")).toBe(true);
    expect(perms.has("job:read")).toBe(true);
    expect(perms.has("product:read")).toBe(true);
  });

  it("exempts management-tier roles (status:write present)", () => {
    const s = snap([{ siteId: SITE_A, permissions: ADMIN_PERMS }], null, undefined, [SITE_A]);
    const perms = snapshotEffectivePermissions(s, SITE_A);
    expect(perms.has("status:read")).toBe(true);
    expect(perms.has("calls:read")).toBe(true);
  });

  it("exempts WORKSPACE-scope roles even when every site is strict", () => {
    const s = snap([{ siteId: null, permissions: MEMBER_READS }], null, undefined, [SITE_A, SITE_B]);
    expect(snapshotEffectivePermissions(s, SITE_A).has("status:read")).toBe(true);
  });

  it("grants re-add floor reads only at the granted workcenter", () => {
    const s = snap(
      [{ siteId: SITE_A, permissions: MEMBER_READS }],
      null,
      [{ workcenterId: WC_1, siteId: SITE_A, access: "READ" }],
      [SITE_A],
    );
    expect(snapshotHasPermission(s, "status:read", SITE_A)).toBe(false);
    expect(snapshotHasPermission(s, "status:read", SITE_A, WC_2)).toBe(false);
    expect(snapshotHasPermission(s, "status:read", SITE_A, WC_1)).toBe(true);
    expect(snapshotHasPermission(s, "calls:read", SITE_A, WC_1)).toBe(true);
  });

  it("applies per site in multi-site snapshots", () => {
    const s = snap(
      [
        { siteId: SITE_A, permissions: MEMBER_READS },
        { siteId: SITE_B, permissions: MEMBER_READS },
      ],
      null,
      undefined,
      [SITE_A],
    );
    expect(snapshotHasPermission(s, "status:read", SITE_A)).toBe(false);
    expect(snapshotHasPermission(s, "status:read", SITE_B)).toBe(true);
  });

  it("accessible sites: floor perms exclude strict sites, facility:read still includes them", () => {
    const s = snap([{ siteId: SITE_A, permissions: MEMBER_READS }], null, undefined, [SITE_A]);
    expect(snapshotAccessibleSites(s, "status:read")).toEqual({ all: false, siteIds: [] });
    expect(snapshotAccessibleSites(s, "facility:read")).toEqual({ all: false, siteIds: [SITE_A] });
    // A grant still counts its site for floor perms.
    const withGrant = snap(
      [{ siteId: SITE_A, permissions: MEMBER_READS }],
      null,
      [{ workcenterId: WC_1, siteId: SITE_A, access: "READ" }],
      [SITE_A],
    );
    expect(snapshotAccessibleSites(withGrant, "status:read")).toEqual({ all: false, siteIds: [SITE_A] });
  });

  it("absent policy field behaves exactly like today; system roles unaffected", () => {
    const legacy = snap([{ siteId: SITE_A, permissions: MEMBER_READS }]);
    expect(snapshotEffectivePermissions(legacy, SITE_A).has("status:read")).toBe(true);
    const support = snapshotEffectivePermissions(snap([], "SUPPORT", undefined, [SITE_A]), SITE_A);
    expect(support.has("status:read")).toBe(true);
  });
});

// ── New eight-key catalog (transition) ───────────────────────────────────
// Role rows may hold legacy keys, new keys, or both during the transition;
// the evaluator treats each string literally (no runtime mapping between
// vocabularies — the expand/contract data migrations own that).

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

  it("legacy keys pass through without implication; unknown strings are dropped", () => {
    expect(expandPermissions(["job:write", "bogus:verb"])).toEqual(new Set(["job:write"]));
  });
});

describe("explicit new-key roles", () => {
  it("new keys in a role array evaluate directly, with implications", () => {
    const s = snap([{ siteId: SITE_A, permissions: ["production:write", "plant:admin"] }]);
    expect(snapshotHasPermission(s, "production:write", SITE_A)).toBe(true);
    expect(snapshotHasPermission(s, "production:read", SITE_A)).toBe(true);
    expect(snapshotHasPermission(s, "plant:admin", SITE_A)).toBe(true);
    expect(snapshotHasPermission(s, "production:admin", SITE_A)).toBe(false);
  });

  it("mixed-vocabulary arrays (transition data) evaluate both key sets literally", () => {
    const s = snap([{ siteId: SITE_A, permissions: ["job:read", "schedule:read", "planning:read"] }]);
    expect(snapshotHasPermission(s, "planning:read", SITE_A)).toBe(true);
    expect(snapshotHasPermission(s, "job:read", SITE_A)).toBe(true);
    // Literal evaluation only: legacy keys never satisfy new checks or
    // vice versa without the key being present.
    expect(snapshotHasPermission(s, "production:read", SITE_A)).toBe(false);
    expect(snapshotHasPermission(s, "planning:write", SITE_A)).toBe(false);
  });

  it("snapshotAccessibleSites sees implied keys, workspace-wide included", () => {
    const writer = snap([{ siteId: SITE_A, permissions: ["production:write"] }]);
    expect(snapshotAccessibleSites(writer, "production:read")).toEqual({ all: false, siteIds: [SITE_A] });
    const workspace = snap([{ siteId: null, permissions: ["production:write"] }]);
    expect(snapshotAccessibleSites(workspace, "production:read")).toEqual({ all: true });
  });
});

describe("floor policy × new keys (GRANTS_REQUIRED)", () => {
  it("an explicit production:read is stripped at a strict site like the legacy floor reads", () => {
    const s = snap([{ siteId: SITE_A, permissions: ["production:read", "planning:read"] }], null, undefined, [SITE_A]);
    expect(snapshotHasPermission(s, "production:read", SITE_A)).toBe(false);
    // Non-floor keys are untouched.
    expect(snapshotHasPermission(s, "planning:read", SITE_A)).toBe(true);
  });

  it("production:write and production:admin roles are management-tier exempt", () => {
    const writer = snap([{ siteId: SITE_A, permissions: ["production:write"] }], null, undefined, [SITE_A]);
    expect(snapshotHasPermission(writer, "production:read", SITE_A)).toBe(true);
    const admin = snap([{ siteId: SITE_A, permissions: ["production:admin"] }], null, undefined, [SITE_A]);
    expect(snapshotHasPermission(admin, "production:read", SITE_A)).toBe(true);
  });

  it("a grant re-adds production:read only at its workcenter at a strict site", () => {
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
});

describe("workcenter grants × new keys", () => {
  it("READ confers production:read at the granted workcenter only, nothing site-wide", () => {
    const s = snap([], null, [{ workcenterId: WC_1, siteId: SITE_A, access: "READ" }]);
    expect(snapshotHasPermission(s, "production:read", SITE_A, WC_1)).toBe(true);
    expect(snapshotHasPermission(s, "production:read", SITE_A, WC_2)).toBe(false);
    expect(snapshotHasPermission(s, "production:read", SITE_A)).toBe(false);
    expect(snapshotHasPermission(s, "production:write", SITE_A, WC_1)).toBe(false);
    // Grants never confer the planning group (target model: production only).
    expect(snapshotHasPermission(s, "planning:read", SITE_A)).toBe(false);
  });

  it("WRITE confers production:write at the granted workcenter, never plant-wide authority", () => {
    const s = snap([], null, [{ workcenterId: WC_1, siteId: SITE_A, access: "WRITE" }]);
    expect(snapshotHasPermission(s, "production:write", SITE_A, WC_1)).toBe(true);
    expect(snapshotHasPermission(s, "production:write", SITE_A, WC_2)).toBe(false);
    expect(snapshotHasPermission(s, "planning:write", SITE_A)).toBe(false);
    expect(snapshotHasPermission(s, "plant:admin", SITE_A, WC_1)).toBe(false);
    expect(snapshotHasPermission(s, "configuration:write", SITE_A, WC_1)).toBe(false);
    expect(snapshotHasPermission(s, "production:admin", SITE_A, WC_1)).toBe(false);
  });

  it("grant workcenters are listable by the new keys", () => {
    const s = snap([], null, [{ workcenterId: WC_1, siteId: SITE_A, access: "WRITE" }]);
    expect(snapshotWorkcentersWithPermission(s, "production:write", SITE_A)).toEqual([WC_1]);
    expect(snapshotWorkcentersWithPermission(s, "production:read", SITE_A)).toEqual([WC_1]);
  });
});

describe("system roles × new keys", () => {
  it("SUPPORT gains the new read keys, nothing more", () => {
    expect(SYSTEM_ROLE_PERMISSIONS.SUPPORT.has("production:read")).toBe(true);
    expect(SYSTEM_ROLE_PERMISSIONS.SUPPORT.has("planning:read")).toBe(true);
    expect(SYSTEM_ROLE_PERMISSIONS.SUPPORT.has("configuration:read")).toBe(true);
    expect(SYSTEM_ROLE_PERMISSIONS.SUPPORT.has("production:write")).toBe(false);
    expect(SYSTEM_ROLE_PERMISSIONS.SUPPORT.has("plant:admin")).toBe(false);
  });

  it("ENGINEER carries every new key but never owner:all", () => {
    for (const p of CUSTOMER_PERMISSIONS) expect(SYSTEM_ROLE_PERMISSIONS.ENGINEER.has(p)).toBe(true);
    expect(SYSTEM_ROLE_PERMISSIONS.ENGINEER.has("owner:all")).toBe(false);
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

import { describe, expect, it } from "vitest";
import {
  type PermissionSnapshot,
  snapshotAccessibleSites,
  snapshotEffectivePermissions,
  snapshotHasPermission,
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
): PermissionSnapshot => ({
  systemRole,
  assignments,
  ...(workcenterGrants ? { workcenterGrants } : {}),
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
    expect(snapshotHasPermission(s, "facility:write", SITE_A, WC_1)).toBe(true);
    expect(snapshotHasPermission(s, "status:write", SITE_A, WC_2)).toBe(false);
    expect(snapshotHasPermission(s, "facility:write", SITE_A)).toBe(false);
    // Plant-admin territory is never conferred by a grant.
    expect(snapshotHasPermission(s, "settings:write", SITE_A, WC_1)).toBe(false);
    expect(snapshotHasPermission(s, "user:read", SITE_A, WC_1)).toBe(false);
    expect(snapshotHasPermission(s, "billing:read", SITE_A, WC_1)).toBe(false);
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

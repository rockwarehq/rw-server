import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  roleAssignment: { findMany: vi.fn() },
  workcenterGrant: { findMany: vi.fn() },
  site: { findMany: vi.fn() },
}));
vi.mock("@rw/db", () => ({ default: db }));

import {
  ALL_PERMISSIONS,
  CUSTOMER_PERMISSIONS,
  LEGACY_CUSTOM_PERMISSION_CATALOG,
  type PermissionSnapshot,
  isPermission,
  listAccessibleSites,
  loadPermissionSnapshot,
  mapLegacyCustomPermissions,
  snapshotAccessibleSites,
  snapshotAccessibleWorkcenters,
  snapshotCanReadReferences,
  snapshotEffectivePermissions,
  snapshotHasPermission,
  snapshotVisibleSites,
  snapshotVisibleWorkcenters,
  validateCustomRolePermissions,
} from "./permissions.js";

const A = "site-a";
const B = "site-b";
const W1 = "workcenter-1";
const W2 = "workcenter-2";
const snap = (
  assignments: PermissionSnapshot["assignments"] = [],
  grants: PermissionSnapshot["workcenterGrants"] = [],
): PermissionSnapshot => ({ systemRole: null, assignments, workcenterGrants: grants });

beforeEach(() => vi.resetAllMocks());

describe("catalog and scope-local implication", () => {
  it("admits exactly eight customer keys and reserved ownership, with no legacy aliases", () => {
    expect(CUSTOMER_PERMISSIONS).toHaveLength(8);
    expect(ALL_PERMISSIONS).toHaveLength(9);
    for (const p of ["planning:admin", "configuration:admin", "plant:read", "status:write", "graph:read"]) {
      expect(isPermission(p)).toBe(false);
    }
    expect(
      snapshotEffectivePermissions(snap([{ siteId: null, permissions: LEGACY_CUSTOM_PERMISSION_CATALOG }])),
    ).toEqual(new Set());
  });

  it("unions matching workspace, site and WC grants without leaking implication to other scopes", () => {
    const s = snap([
      { siteId: null, permissions: ["configuration:write"] },
      { siteId: A, permissions: ["planning:write"] },
      { siteId: A, workcenterId: W1, permissions: ["production:admin"] },
      { siteId: B, permissions: ["plant:admin"] },
    ]);
    expect(snapshotEffectivePermissions(s, A, W1)).toEqual(
      new Set([
        "configuration:write",
        "configuration:read",
        "planning:write",
        "planning:read",
        "production:admin",
        "production:write",
        "production:read",
      ]),
    );
    for (const p of ["production:read", "production:write", "production:admin"] as const) {
      expect(snapshotHasPermission(s, p, A)).toBe(false);
      expect(snapshotHasPermission(s, p, A, W2)).toBe(false);
      expect(snapshotHasPermission(s, p, B, W1)).toBe(false);
      expect(snapshotHasPermission(s, p)).toBe(false);
    }
    expect(snapshotEffectivePermissions(s)).toEqual(new Set(["configuration:write", "configuration:read"]));
  });

  it("plant administration and ownership do not imply operational permissions", () => {
    const s = snap([{ siteId: A, permissions: ["plant:admin", "owner:all"] }]);
    expect(snapshotEffectivePermissions(s, A)).toEqual(new Set(["plant:admin"]));
    expect(snapshotHasPermission(s, "plant:admin")).toBe(false);
    expect(snapshotEffectivePermissions(snap([{ siteId: null, permissions: ["owner:all"] }]), A)).toEqual(
      new Set(["owner:all"]),
    );
  });

  it("accepts undefined/null legacy assignment WC fields as site scope and ignores base-policy markers", () => {
    for (const workcenterId of [undefined, null]) {
      const s = {
        ...snap([{ siteId: A, workcenterId, permissions: ["production:read", "status:write"] }]),
        grantsRequiredSiteIds: [A],
      };
      expect(snapshotHasPermission(s, "production:read", A, W2)).toBe(true);
      expect(snapshotHasPermission(s, "production:write", A, W2)).toBe(false);
    }
  });

  it("fails closed for malformed WC assignments even if their role contains admin keys", () => {
    const s = snap([
      { siteId: null, workcenterId: W1, permissions: ["production:admin", "owner:all"] },
      { siteId: A, workcenterId: W1, permissions: ["planning:write", "plant:admin", "configuration:write"] },
    ]);
    expect(snapshotEffectivePermissions(s, A, W1)).toEqual(new Set());
    expect(snapshotAccessibleSites(s, "production:read")).toEqual({ all: false, siteIds: [] });
  });

  it("internal SUPPORT reads the new catalog and ENGINEER has all customer capabilities, never ownership", () => {
    const support = { systemRole: "SUPPORT", assignments: [{ siteId: null, permissions: ["owner:all"] }] };
    expect(snapshotEffectivePermissions(support)).toEqual(
      new Set(["production:read", "planning:read", "configuration:read"]),
    );
    expect(snapshotEffectivePermissions({ ...support, systemRole: "ENGINEER" })).toEqual(new Set(CUSTOMER_PERMISSIONS));
    expect(snapshotVisibleSites({ ...support, systemRole: "unknown" })).toEqual({ all: false, siteIds: [] });
  });
});

describe("assigned workcenter isolation and visibility", () => {
  it.each(["READ", "WRITE"])("%s never expands into site-wide production or planning/configuration", (access) => {
    const s = snap([], [{ siteId: A, workcenterId: W1, access }]);
    expect(snapshotEffectivePermissions(s, A)).toEqual(new Set());
    expect(snapshotEffectivePermissions(s, A, W2)).toEqual(new Set());
    expect(snapshotEffectivePermissions(s, B, W1)).toEqual(new Set());
    expect(snapshotEffectivePermissions(s, A, W1)).toEqual(
      new Set(access === "WRITE" ? ["production:read", "production:write"] : ["production:read"]),
    );
    expect(snapshotVisibleWorkcenters(s, A)).toEqual({ all: false, workcenterIds: [W1] });
  });

  it("returns consistent additive WC sets across access grants and custom roles", () => {
    const s = snap(
      [
        { siteId: A, workcenterId: W1, permissions: ["production:admin"] },
        { siteId: A, workcenterId: W2, permissions: ["production:write"] },
      ],
      [
        { siteId: A, workcenterId: W1, access: "READ" },
        { siteId: B, workcenterId: "other", access: "WRITE" },
      ],
    );
    expect(snapshotAccessibleWorkcenters(s, "production:write", A)).toEqual({ all: false, workcenterIds: [W1, W2] });
    expect(snapshotAccessibleWorkcenters(s, "production:admin", A)).toEqual({ all: false, workcenterIds: [W1] });
    expect(snapshotAccessibleSites(s, "production:read")).toEqual({ all: false, siteIds: [A, B] });
    expect(snapshotHasPermission(s, "production:read", A)).toBe(false);
    s.assignments.push({ siteId: A, permissions: ["production:admin"] });
    expect(snapshotAccessibleWorkcenters(s, "production:write", A)).toEqual({ all: true });
  });

  it("Plant Member may enter its site and read references but sees no unassigned live floor", () => {
    const s = snap([{ siteId: A, permissions: ["planning:read"] }]);
    expect(snapshotVisibleSites(s)).toEqual({ all: false, siteIds: [A] });
    expect(snapshotVisibleWorkcenters(s, A)).toEqual({ all: false, workcenterIds: [] });
    expect(snapshotCanReadReferences(s, A)).toBe(true);
    expect(snapshotCanReadReferences(s, B)).toBe(false);
    expect(snapshotHasPermission(s, "production:read", A, W1)).toBe(false);
  });

  it("membership visibility survives conservative migration of a role to an empty permission array", () => {
    expect(snapshotVisibleSites(snap([{ siteId: A, permissions: [] }]))).toEqual({ all: false, siteIds: [A] });
    expect(snapshotVisibleSites(snap([], [{ siteId: B, workcenterId: W1, access: "WRITE" }]))).toEqual({
      all: false,
      siteIds: [B],
    });
  });
});

describe("custom scope validation and migration preview", () => {
  it("accepts production custom roles at WC scope and rejects broad/reserved capabilities", () => {
    expect(validateCustomRolePermissions(["production:admin"], "WORKCENTER")).toEqual(["production:admin"]);
    for (const p of ["plant:admin", "planning:read", "configuration:write", "owner:all", "status:write"]) {
      expect(() => validateCustomRolePermissions([p], "WORKCENTER")).toThrow();
    }
    expect(() => validateCustomRolePermissions(["owner:all"], "WORKSPACE")).toThrow(/reserved/);
  });

  it("reports lost partial legacy grants instead of broadening unrelated capabilities", () => {
    const old = ["status:write", "job:write", "settings:admin", "owner:all", "production:write"];
    const delta = mapLegacyCustomPermissions(old);
    expect(delta.permissions).toEqual(["production:write"]);
    expect(delta.effectivePermissions).toEqual(["production:write", "production:read"]);
    expect(delta.droppedPermissions).toEqual(old.slice(0, 4));
    expect(delta.addedPermissions).toEqual([]);
    expect(delta.requiresReview).toBe(true);
    expect(delta.originalPermissions).toEqual(old);
    expect(old).toHaveLength(5);
  });

  it("requires the entire old catalog specifically for production administration", () => {
    expect(mapLegacyCustomPermissions(LEGACY_CUSTOM_PERMISSION_CATALOG).permissions).toEqual(CUSTOMER_PERMISSIONS);
    expect(mapLegacyCustomPermissions(LEGACY_CUSTOM_PERMISSION_CATALOG).requiresReview).toBe(true);
    expect(mapLegacyCustomPermissions(LEGACY_CUSTOM_PERMISSION_CATALOG.slice(1)).permissions).not.toContain(
      "production:admin",
    );
    expect(mapLegacyCustomPermissions(LEGACY_CUSTOM_PERMISSION_CATALOG, "WORKCENTER").permissions).toEqual([
      "production:read",
      "production:write",
      "production:admin",
    ]);
  });
});

describe("snapshot loading and site picker", () => {
  it("loads WC scope and lists sites by membership without a facility permission or attrs query", async () => {
    db.user.findUnique.mockResolvedValue({ systemRole: null });
    db.roleAssignment.findMany.mockResolvedValue([
      { siteId: A, workcenterId: W1, role: { permissions: ["production:admin"] } },
      { siteId: B, workcenterId: null, role: { permissions: [] } },
    ]);
    db.workcenterGrant.findMany.mockResolvedValue([]);
    const loaded = await loadPermissionSnapshot("user", "workspace");
    expect(loaded?.assignments[0]?.workcenterId).toBe(W1);
    expect(db.site.findMany).not.toHaveBeenCalled();
    db.site.findMany.mockResolvedValue([]);
    await listAccessibleSites("user", "workspace");
    expect(db.site.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace", id: { in: [A, B] } },
      }),
    );
    await listAccessibleSites("user", "workspace", "production:read");
    expect(db.site.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace", id: { in: [A] } },
      }),
    );
  });
});

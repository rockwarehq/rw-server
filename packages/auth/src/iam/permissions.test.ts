import { describe, expect, it } from "vitest";
import {
  type PermissionSnapshot,
  snapshotAccessibleSites,
  snapshotEffectivePermissions,
  snapshotHasPermission,
} from "./permissions.js";

const SITE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SITE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const snap = (
  assignments: PermissionSnapshot["assignments"],
  systemRole: string | null = null,
): PermissionSnapshot => ({
  systemRole,
  assignments,
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

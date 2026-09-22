import { describe, expect, expectTypeOf, it, vi } from "vitest";
vi.mock("@rw/db", () => ({ default: {} }));
import type { IAMContext } from "../context.js";
import { ALL_PERMISSIONS, type AccessibleSites, type PermissionSnapshot } from "./permissions.js";
import {
  createPolicy,
  type PolicyDeps,
  type PolicyDenial,
  type SiteGrant,
  scopeFilter,
  scopeWhere,
  scopeWorkcenterWhere,
} from "./policy.js";

const A = "site-a";
const B = "site-b";
const W1 = "workcenter-1";
const W2 = "workcenter-2";
const workspaceId = "workspace";
const user = (assignments: PermissionSnapshot["assignments"] = []): IAMContext => ({
  principal: "USER",
  validToken: true,
  id: "user",
  workspaceId,
  siteId: A,
  permissionSnapshot: { systemRole: null, assignments },
});
const operator = (): IAMContext => ({
  ...user(),
  permissionSnapshot: {
    systemRole: null,
    assignments: [],
    workcenterGrants: [{ siteId: A, workcenterId: W1, access: "WRITE" }],
  },
});
const device = (principal: "DISPLAY" | "APP"): IAMContext => ({ principal, validToken: true, workspaceId, siteId: A });
const siteGrant = (siteId = A) => ({ ok: true, workspaceId, siteId });
const forbidden = { ok: false, code: "FORBIDDEN" };

function buildPolicy(overrides: Partial<PolicyDeps> = {}) {
  const deps: PolicyDeps = {
    hasPermission: vi.fn(async () => false),
    getAccessibleSites: vi.fn(async () => ({ all: false, siteIds: [] }) as AccessibleSites),
    getVisibleSites: vi.fn(async () => ({ all: false, siteIds: [A] }) as AccessibleSites),
    loadPermissionSnapshot: vi.fn(async () => null),
    resolveSiteRef: vi.fn(async () => ({ siteId: A, workcenterId: W1, stationId: "station-1" })),
    ...overrides,
  };
  return { policy: createPolicy(deps), deps };
}

describe("authorization guards and scope isolation", () => {
  it("keeps authentication, workspace, worker and missing-resource denials explicit", async () => {
    const { policy, deps } = buildPolicy({ resolveSiteRef: vi.fn(async () => null) });
    const check = { permission: "production:read", scope: { kind: "station", id: "missing" } } as const;
    for (const iam of [
      undefined,
      { ...user(), validToken: false },
      { ...user(), id: undefined },
      { ...user(), principal: "WORKER" } as IAMContext,
    ]) {
      expect(await policy.authorize(iam, check)).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
    }
    expect(await policy.authorize({ ...user(), workspaceId: undefined }, check)).toMatchObject({
      ok: false,
      code: "NO_WORKSPACE",
    });
    expect(await policy.authorize(user(), check)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(deps.hasPermission).not.toHaveBeenCalled();
  });

  it("authorizes a resolved assigned station but not a sibling WC, another site or a null-WC station", async () => {
    const resolveSiteRef = vi.fn<PolicyDeps["resolveSiteRef"]>().mockResolvedValue({ siteId: A, workcenterId: W1 });
    const { policy } = buildPolicy({ resolveSiteRef });
    const check = { permission: "production:write", scope: { kind: "station", id: "station" } } as const;
    expect(await policy.authorize(operator(), check)).toEqual(siteGrant());
    for (const row of [
      { siteId: A, workcenterId: W2 },
      { siteId: B, workcenterId: W1 },
      { siteId: A, workcenterId: null },
    ]) {
      resolveSiteRef.mockResolvedValue(row);
      expect(await policy.authorize(operator(), check)).toMatchObject(forbidden);
    }
  });

  it("WC custom admin implies write at that WC, not at the site", async () => {
    const { policy } = buildPolicy();
    const iam = user([{ siteId: A, workcenterId: W1, permissions: ["production:admin"] }]);
    expect(
      await policy.authorize(iam, { permission: "production:write", scope: { kind: "station", id: "s" } }),
    ).toEqual(siteGrant());
    expect(
      await policy.authorize(iam, { permission: "production:admin", scope: { kind: "site", siteId: A } }),
    ).toMatchObject(forbidden);
    expect(
      await policy.authorize(iam, { permission: "plant:admin", scope: { kind: "station", id: "s" } }),
    ).toMatchObject(forbidden);
  });

  it("Plant Admin is site-bounded while Company Administrator owns the workspace", async () => {
    const { policy } = buildPolicy();
    const plant = user([
      { siteId: A, permissions: ["production:admin", "planning:write", "configuration:write", "plant:admin"] },
    ]);
    const company = user([{ siteId: null, permissions: ALL_PERMISSIONS }]);
    expect(await policy.authorize(plant, { permission: "plant:admin", scope: { kind: "site", siteId: A } })).toEqual(
      siteGrant(),
    );
    expect(
      await policy.authorize(plant, { permission: "production:read", scope: { kind: "site", siteId: B } }),
    ).toMatchObject(forbidden);
    for (const permission of ["plant:admin", "owner:all"] as const) {
      for (const scope of [{ kind: "workspace" }, { kind: "anySite" }] as const) {
        expect(await policy.authorize(plant, { permission, scope })).toMatchObject(forbidden);
        expect(await policy.authorize(company, { permission, scope })).toEqual({ ok: true, workspaceId });
      }
    }
  });

  it("null-site administration cannot inherit a single site's grant", async () => {
    const { policy } = buildPolicy({ resolveSiteRef: vi.fn(async () => ({ siteId: null })) });
    const plant = user([{ siteId: A, permissions: ["configuration:write", "plant:admin"] }]);
    const check = { permission: "configuration:write", scope: { kind: "gateway", id: "unassigned" } } as const;
    expect(await policy.authorize(plant, check)).toMatchObject(forbidden);
    expect(await policy.authorize(user([{ siteId: null, permissions: ["configuration:write"] }]), check)).toEqual({
      ok: true,
      workspaceId,
    });
  });
});

describe("list and membership scopes", () => {
  it("preserves WC restrictions through every list-filter adapter and excludes null-WC rows", async () => {
    const { policy } = buildPolicy();
    const result = await policy.authorizeList(operator(), { permission: "production:read" });
    expect(result).toEqual({ ...siteGrant(), workcenterIds: [W1] });
    if (!result.ok) throw new Error("Expected list scope");
    expect(scopeFilter(result)).toEqual({ workspaceId, siteId: A, workcenterIds: [W1] });
    expect(scopeWhere(result)).toEqual({ siteId: A });
    expect(scopeWorkcenterWhere(result)).toEqual({ workcenterId: { in: [W1] } });
    expect(scopeWorkcenterWhere({ ...result, workcenterIds: [] })).toEqual({ workcenterId: { in: [] } });
    expect(await policy.authorizeList(operator(), { permission: "production:read", requestedSiteId: B })).toMatchObject(
      forbidden,
    );
  });

  it("site-wide production grants cover all WCs, while Planner has no live production list", async () => {
    const { policy } = buildPolicy();
    expect(
      await policy.authorizeList(user([{ siteId: A, permissions: ["production:admin"] }]), {
        permission: "production:read",
      }),
    ).toEqual(siteGrant());
    expect(
      await policy.authorizeList(user([{ siteId: A, permissions: ["planning:write"] }]), {
        permission: "production:read",
      }),
    ).toMatchObject(forbidden);
  });

  it("supports non-snapshot callers without losing their WC scope", async () => {
    const snapshot = operator().permissionSnapshot!;
    const { policy, deps } = buildPolicy({ loadPermissionSnapshot: vi.fn(async () => snapshot) });
    expect(
      await policy.authorizeList({ ...operator(), permissionSnapshot: undefined }, { permission: "production:read" }),
    ).toEqual({ ...siteGrant(), workcenterIds: [W1] });
    expect(deps.loadPermissionSnapshot).toHaveBeenCalledWith("user", workspaceId);
  });

  it("site entry does not depend on operational permissions", async () => {
    const { policy } = buildPolicy();
    const iam = user([{ siteId: A, permissions: [] }]);
    expect(await policy.authorizeAccessibleSites(iam)).toEqual({ ok: true, workspaceId, siteIds: [A] });
    expect(await policy.authorizeAccessibleSites(iam, { permission: "production:read" })).toEqual({
      ok: true,
      workspaceId,
      siteIds: [],
    });
    expect(await policy.authorizeAccessibleSites(device("DISPLAY"))).toEqual({ ok: true, workspaceId, siteIds: [A] });
  });
});

describe("explicit shared-reference reads", () => {
  it("a scoped operator can read site references but gains no general site-wide production access", async () => {
    const { policy } = buildPolicy();
    expect(await policy.authorizeReferenceRead(operator(), { scope: { kind: "site", siteId: A } })).toEqual(
      siteGrant(),
    );
    expect(
      await policy.authorize(operator(), { permission: "production:read", scope: { kind: "site", siteId: A } }),
    ).toMatchObject(forbidden);
    expect(await policy.authorizeReferenceRead(operator(), { scope: { kind: "site", siteId: B } })).toMatchObject(
      forbidden,
    );
  });

  it("proves the resolved target site, not the active site or another granted site", async () => {
    const { policy } = buildPolicy({ resolveSiteRef: vi.fn(async () => ({ siteId: B })) });
    const scope = { kind: "product", id: "product-at-b" } as const;
    expect(await policy.authorizeReferenceRead(operator(), { scope })).toMatchObject(forbidden);
    const result = await policy.authorizeReferenceRead(user([{ siteId: B, permissions: ["planning:write"] }]), {
      scope,
    });
    expect(result).toEqual(siteGrant(B));
    expectTypeOf(result).toEqualTypeOf<SiteGrant | PolicyDenial>();
  });

  it("rejects workspace/anySite/null-site and absent targets, even for company owners", async () => {
    const { policy } = buildPolicy({ resolveSiteRef: vi.fn(async () => ({ siteId: null })) });
    const company = user([{ siteId: null, permissions: ALL_PERMISSIONS }]);
    for (const scope of [{ kind: "workspace" }, { kind: "anySite" }, { kind: "document", id: "global" }] as const) {
      expect(await policy.authorizeReferenceRead(company, { scope })).toMatchObject(forbidden);
    }
    const missing = buildPolicy({ resolveSiteRef: vi.fn(async () => null) }).policy;
    expect(await missing.authorizeReferenceRead(company, { scope: { kind: "product", id: "missing" } })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("supports DB-backed permission fallback and only same-site DISPLAY reference reads", async () => {
    const { policy } = buildPolicy({
      getAccessibleSites: vi.fn(async () => ({ all: false, siteIds: [B] }) as AccessibleSites),
    });
    const iam = { ...user(), permissionSnapshot: undefined };
    expect(await policy.authorizeReferenceRead(iam, { scope: { kind: "site", siteId: B } })).toEqual(siteGrant(B));
    expect(await policy.authorizeReferenceRead(iam, { scope: { kind: "site", siteId: A } })).toMatchObject(forbidden);
    expect(await policy.authorizeReferenceRead(device("DISPLAY"), { scope: { kind: "site", siteId: A } })).toEqual(
      siteGrant(),
    );
    expect(
      await policy.authorizeReferenceRead(device("DISPLAY"), { scope: { kind: "site", siteId: B } }),
    ).toMatchObject(forbidden);
    expect(await policy.authorizeReferenceRead(device("APP"), { scope: { kind: "site", siteId: A } })).toMatchObject(
      forbidden,
    );
  });
});

describe("device separation", () => {
  it.each([
    "DISPLAY",
    "APP",
  ] as const)("%s cannot acquire mutation/admin capability through any generic entry point", async (principal) => {
    const { policy, deps } = buildPolicy();
    const iam = { ...device(principal), permissionSnapshot: { systemRole: "ENGINEER", assignments: [] } };
    for (const permission of ALL_PERMISSIONS.filter((p) => !p.endsWith(":read"))) {
      for (const scope of [
        { kind: "site", siteId: A },
        { kind: "station", id: "s" },
        { kind: "workspace" },
        { kind: "anySite" },
      ] as const) {
        expect(await policy.authorize(iam, { permission, scope })).toMatchObject(forbidden);
      }
      expect(await policy.authorizeList(iam, { permission })).toMatchObject(forbidden);
      expect(await policy.authorizeAccessibleSites(iam, { permission })).toMatchObject(forbidden);
    }
    expect(deps.hasPermission).not.toHaveBeenCalled();
  });

  it("DISPLAY retains same-site reads; APP user-permission reads remain denied", async () => {
    const { policy } = buildPolicy();
    for (const permission of ["production:read", "planning:read", "configuration:read"] as const) {
      expect(await policy.authorize(device("DISPLAY"), { permission, scope: { kind: "site", siteId: A } })).toEqual(
        siteGrant(),
      );
      expect(
        await policy.authorize(device("DISPLAY"), { permission, scope: { kind: "site", siteId: B } }),
      ).toMatchObject(forbidden);
      expect(await policy.authorize(device("APP"), { permission, scope: { kind: "site", siteId: A } })).toMatchObject(
        forbidden,
      );
      expect(await policy.authorizeList(device("APP"), { permission })).toMatchObject(forbidden);
    }
    expect(await policy.authorizeAccessibleSites(device("APP"))).toMatchObject(forbidden);
  });
});

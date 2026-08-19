import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { AppIAMContext, DisplayIAMContext, IAMContext, UserIAMContext } from "../context.js";
import {
  createPolicy,
  type PolicyDenial,
  type PolicyDeps,
  scopeFilter,
  scopeWhere,
  type SiteGrant,
  type WorkspaceGrant,
} from "./policy.js";

const WORKSPACE = "11111111-1111-1111-1111-111111111111";
const SITE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SITE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STATION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const user = (overrides: Partial<UserIAMContext> = {}): UserIAMContext => ({
  principal: "USER",
  validToken: true,
  id: "user-1",
  email: "u@test.local",
  workspaceId: WORKSPACE,
  ...overrides,
});

const display = (overrides: Partial<DisplayIAMContext> = {}): DisplayIAMContext => ({
  principal: "DISPLAY",
  validToken: true,
  displayId: "display-1",
  siteId: SITE_A,
  workspaceId: WORKSPACE,
  ...overrides,
});

const app = (overrides: Partial<AppIAMContext> = {}): AppIAMContext => ({
  principal: "APP",
  validToken: true,
  apiTokenId: "token-1",
  siteId: SITE_A,
  workspaceId: WORKSPACE,
  scopes: ["graph:read"],
  ...overrides,
});

function buildPolicy(overrides: Partial<PolicyDeps> = {}) {
  const deps: PolicyDeps = {
    hasPermission: vi.fn(async () => true),
    getAccessibleSites: vi.fn(async () => ({ all: true }) as const),
    resolveSiteRef: vi.fn(async () => ({ siteId: SITE_A })),
    ...overrides,
  };
  return { policy: createPolicy(deps), deps };
}

describe("authorize", () => {
  it("denies UNAUTHENTICATED when iam is missing", async () => {
    const { policy } = buildPolicy();
    const result = await policy.authorize(undefined, {
      permission: "facility:read",
      scope: { kind: "site", siteId: SITE_A },
    });
    expect(result).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("denies UNAUTHENTICATED for an invalid token", async () => {
    const { policy } = buildPolicy();
    const iam: IAMContext = { principal: "UNKNOWN", validToken: false };
    const result = await policy.authorize(iam, {
      permission: "facility:read",
      scope: { kind: "site", siteId: SITE_A },
    });
    expect(result).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("denies NO_WORKSPACE for a user token without workspace context", async () => {
    const { policy, deps } = buildPolicy();
    const result = await policy.authorize(user({ workspaceId: undefined }), {
      permission: "facility:read",
      scope: { kind: "site", siteId: SITE_A },
    });
    expect(result).toMatchObject({ ok: false, code: "NO_WORKSPACE" });
    expect(deps.hasPermission).not.toHaveBeenCalled();
  });

  it("grants workspace-kind checks for users with the permission", async () => {
    const { policy, deps } = buildPolicy();
    const result = await policy.authorize(user(), {
      permission: "facility:write",
      scope: { kind: "workspace" },
    });
    expect(result).toEqual({ ok: true, workspaceId: WORKSPACE });
    expect(deps.hasPermission).toHaveBeenCalledWith("user-1", "facility:write", { workspaceId: WORKSPACE });
  });

  it("denies workspace-kind checks for users lacking the permission, echoing it", async () => {
    const { policy } = buildPolicy({ hasPermission: vi.fn(async () => false) });
    const result = await policy.authorize(user(), {
      permission: "facility:write",
      scope: { kind: "workspace" },
    });
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN", permission: "facility:write" });
  });

  it("denies workspace-kind checks for device principals", async () => {
    const { policy, deps } = buildPolicy();
    for (const iam of [display(), app()]) {
      const result = await policy.authorize(iam, {
        permission: "facility:write",
        scope: { kind: "workspace" },
      });
      expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    expect(deps.hasPermission).not.toHaveBeenCalled();
  });

  it("grants site-kind checks without resolving", async () => {
    const { policy, deps } = buildPolicy();
    const result = await policy.authorize(user(), {
      permission: "facility:read",
      scope: { kind: "site", siteId: SITE_B },
    });
    expect(result).toEqual({ ok: true, workspaceId: WORKSPACE, siteId: SITE_B });
    expect(deps.resolveSiteRef).not.toHaveBeenCalled();
    expect(deps.hasPermission).toHaveBeenCalledWith("user-1", "facility:read", {
      workspaceId: WORKSPACE,
      siteId: SITE_B,
    });
  });

  it("resolves resource refs and grants when the user holds the permission at that site", async () => {
    const { policy, deps } = buildPolicy();
    const result = await policy.authorize(user(), {
      permission: "facility:write",
      scope: { kind: "station", id: STATION },
    });
    expect(result).toEqual({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A });
    expect(deps.resolveSiteRef).toHaveBeenCalledWith({ kind: "station", id: STATION });
  });

  it("denies FORBIDDEN when the user lacks the permission at the resolved site", async () => {
    const { policy } = buildPolicy({ hasPermission: vi.fn(async () => false) });
    const result = await policy.authorize(user(), {
      permission: "facility:admin",
      scope: { kind: "workcenter", id: STATION },
    });
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN", permission: "facility:admin" });
  });

  it("returns NOT_FOUND for unresolvable refs without calling hasPermission", async () => {
    const { policy, deps } = buildPolicy({ resolveSiteRef: vi.fn(async () => null) });
    const result = await policy.authorize(user(), {
      permission: "facility:read",
      scope: { kind: "station", id: STATION },
    });
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(deps.hasPermission).not.toHaveBeenCalled();
  });

  it("grants device principals on their own site without permission queries", async () => {
    const { policy, deps } = buildPolicy();
    for (const iam of [display(), app()]) {
      const result = await policy.authorize(iam, {
        permission: "facility:read",
        scope: { kind: "site", siteId: SITE_A },
      });
      expect(result).toEqual({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A });
    }
    expect(deps.hasPermission).not.toHaveBeenCalled();
  });

  it("denies device principals outside their own site", async () => {
    const { policy } = buildPolicy();
    for (const iam of [display(), app()]) {
      const result = await policy.authorize(iam, {
        permission: "facility:read",
        scope: { kind: "site", siteId: SITE_B },
      });
      expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
  });

  it("checks device site binding against the resolved site for resource refs", async () => {
    const { policy } = buildPolicy({ resolveSiteRef: vi.fn(async () => ({ siteId: SITE_B })) });
    const result = await policy.authorize(display(), {
      permission: "facility:read",
      scope: { kind: "station", id: STATION },
    });
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

describe("anySite refs", () => {
  it("grants users holding the permission workspace-wide", async () => {
    const { policy, deps } = buildPolicy();
    const result = await policy.authorize(user(), {
      permission: "employee:write",
      scope: { kind: "anySite" },
    });
    expect(result).toEqual({ ok: true, workspaceId: WORKSPACE });
    expect(deps.getAccessibleSites).toHaveBeenCalledWith("user-1", "employee:write", WORKSPACE);
  });

  it("grants users holding the permission at one or more sites", async () => {
    const { policy } = buildPolicy({
      getAccessibleSites: vi.fn(async () => ({ all: false as const, siteIds: [SITE_A] })),
    });
    const result = await policy.authorize(user(), {
      permission: "employee:write",
      scope: { kind: "anySite" },
    });
    expect(result).toEqual({ ok: true, workspaceId: WORKSPACE });
  });

  it("denies users holding the permission at zero sites, echoing it", async () => {
    const { policy } = buildPolicy({
      getAccessibleSites: vi.fn(async () => ({ all: false as const, siteIds: [] as string[] })),
    });
    const result = await policy.authorize(user(), {
      permission: "employee:write",
      scope: { kind: "anySite" },
    });
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN", permission: "employee:write" });
  });

  it("denies device principals outright", async () => {
    const { policy, deps } = buildPolicy();
    for (const iam of [display(), app()]) {
      const result = await policy.authorize(iam, {
        permission: "facility:read",
        scope: { kind: "anySite" },
      });
      expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    expect(deps.getAccessibleSites).not.toHaveBeenCalled();
  });
});

describe("null-site resources", () => {
  it("applies the anySite rule when a resolver returns a row without a site", async () => {
    const { policy, deps } = buildPolicy({
      resolveSiteRef: vi.fn(async () => ({ siteId: null })),
      getAccessibleSites: vi.fn(async () => ({ all: false as const, siteIds: [SITE_A] })),
    });
    const result = await policy.authorize(user(), {
      permission: "facility:write",
      scope: { kind: "gateway", id: STATION },
    });
    expect(result).toEqual({ ok: true, workspaceId: WORKSPACE });
    expect(deps.hasPermission).not.toHaveBeenCalled();
  });

  it("denies users with zero accessible sites on null-site resources", async () => {
    const { policy } = buildPolicy({
      resolveSiteRef: vi.fn(async () => ({ siteId: null })),
      getAccessibleSites: vi.fn(async () => ({ all: false as const, siteIds: [] as string[] })),
    });
    const result = await policy.authorize(user(), {
      permission: "facility:write",
      scope: { kind: "gateway", id: STATION },
    });
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN", permission: "facility:write" });
  });

  it("denies device principals on null-site resources", async () => {
    const { policy } = buildPolicy({ resolveSiteRef: vi.fn(async () => ({ siteId: null })) });
    const result = await policy.authorize(display(), {
      permission: "facility:read",
      scope: { kind: "document", id: STATION },
    });
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("still distinguishes a missing row (NOT_FOUND)", async () => {
    const { policy } = buildPolicy({ resolveSiteRef: vi.fn(async () => null) });
    const result = await policy.authorize(user(), {
      permission: "facility:read",
      scope: { kind: "gateway", id: STATION },
    });
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("authorizeList (single-site)", () => {
  it("defaults to the token's active site", async () => {
    const { policy, deps } = buildPolicy();
    const result = await policy.authorizeList(user({ siteId: SITE_A }), { permission: "facility:read" });
    expect(result).toEqual({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A });
    expect(deps.hasPermission).toHaveBeenCalledWith("user-1", "facility:read", {
      workspaceId: WORKSPACE,
      siteId: SITE_A,
    });
  });

  it("authorizes an explicitly requested site over the token site", async () => {
    const { policy } = buildPolicy();
    const result = await policy.authorizeList(user({ siteId: SITE_A }), {
      permission: "facility:read",
      requestedSiteId: SITE_B,
    });
    expect(result).toEqual({ ok: true, workspaceId: WORKSPACE, siteId: SITE_B });
  });

  it("denies a requested site the user lacks the permission at, echoing it", async () => {
    const { policy } = buildPolicy({ hasPermission: vi.fn(async () => false) });
    const result = await policy.authorizeList(user({ siteId: SITE_A }), {
      permission: "facility:read",
      requestedSiteId: SITE_B,
    });
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN", permission: "facility:read" });
  });

  it("denies when neither a requested site nor a token site exists", async () => {
    const { policy, deps } = buildPolicy();
    const result = await policy.authorizeList(user(), { permission: "facility:read" });
    expect(result).toMatchObject({ ok: false, code: "NO_WORKSPACE", message: "Site context required" });
    expect(deps.hasPermission).not.toHaveBeenCalled();
  });

  it("scopes device principals to their own site", async () => {
    const { policy, deps } = buildPolicy();
    for (const iam of [display(), app()]) {
      const result = await policy.authorizeList(iam, { permission: "facility:read" });
      expect(result).toEqual({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A });
    }
    expect(deps.hasPermission).not.toHaveBeenCalled();
  });

  it("denies device principals requesting a foreign site", async () => {
    const { policy } = buildPolicy();
    const result = await policy.authorizeList(display(), {
      permission: "facility:read",
      requestedSiteId: SITE_B,
    });
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

describe("authorizeAccessibleSites (site directory)", () => {
  it("returns all sites (undefined) for unrestricted users", async () => {
    const { policy } = buildPolicy();
    const result = await policy.authorizeAccessibleSites(user(), { permission: "facility:read" });
    expect(result).toEqual({ ok: true, workspaceId: WORKSPACE });
  });

  it("returns the accessible subset for site-restricted users", async () => {
    const { policy } = buildPolicy({
      getAccessibleSites: vi.fn(async () => ({ all: false as const, siteIds: [SITE_A] })),
    });
    const result = await policy.authorizeAccessibleSites(user(), { permission: "facility:read" });
    expect(result).toEqual({ ok: true, workspaceId: WORKSPACE, siteIds: [SITE_A] });
  });

  it("pins device principals to their own site", async () => {
    const { policy } = buildPolicy();
    const result = await policy.authorizeAccessibleSites(display(), { permission: "facility:read" });
    expect(result).toEqual({ ok: true, workspaceId: WORKSPACE, siteIds: [SITE_A] });
  });
});

describe("with a per-request permission snapshot", () => {
  const snapshotUser = (
    assignments: Array<{ siteId: string | null; permissions: string[] }>,
    overrides: Partial<UserIAMContext> = {},
  ) => user({ permissionSnapshot: { systemRole: null, assignments }, ...overrides });

  it("authorize evaluates the snapshot without calling deps.hasPermission", async () => {
    const { policy, deps } = buildPolicy();
    const iam = snapshotUser([{ siteId: SITE_A, permissions: ["facility:write"] }]);

    const allowed = await policy.authorize(iam, {
      permission: "facility:write",
      scope: { kind: "site", siteId: SITE_A },
    });
    expect(allowed).toEqual({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A });

    const denied = await policy.authorize(iam, {
      permission: "facility:write",
      scope: { kind: "site", siteId: SITE_B },
    });
    expect(denied).toMatchObject({ ok: false, code: "FORBIDDEN", permission: "facility:write" });

    expect(deps.hasPermission).not.toHaveBeenCalled();
  });

  it("authorize still resolves resource refs before evaluating the snapshot", async () => {
    const { policy, deps } = buildPolicy({ resolveSiteRef: vi.fn(async () => null) });
    const result = await policy.authorize(snapshotUser([{ siteId: null, permissions: ["facility:read"] }]), {
      permission: "facility:read",
      scope: { kind: "station", id: STATION },
    });
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(deps.hasPermission).not.toHaveBeenCalled();
  });

  it("authorizeList evaluates the snapshot at the active site", async () => {
    const { policy, deps } = buildPolicy();
    const iam = snapshotUser([{ siteId: SITE_A, permissions: ["facility:read"] }], { siteId: SITE_A });

    const scope = await policy.authorizeList(iam, { permission: "facility:read" });
    expect(scope).toEqual({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A });

    const denied = await policy.authorizeList(iam, { permission: "facility:read", requestedSiteId: SITE_B });
    expect(denied).toMatchObject({ ok: false, code: "FORBIDDEN" });

    expect(deps.hasPermission).not.toHaveBeenCalled();
  });

  it("workspace-level snapshot assignments grant any requested site", async () => {
    const { policy, deps } = buildPolicy();
    const iam = snapshotUser([{ siteId: null, permissions: ["facility:read"] }], { siteId: SITE_A });
    const scope = await policy.authorizeList(iam, { permission: "facility:read", requestedSiteId: SITE_B });
    expect(scope).toEqual({ ok: true, workspaceId: WORKSPACE, siteId: SITE_B });
    expect(deps.hasPermission).not.toHaveBeenCalled();
  });
});

describe("scopeFilter / scopeWhere", () => {
  it("produce single-site fragments", () => {
    expect(scopeFilter({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A })).toEqual({
      workspaceId: WORKSPACE,
      siteId: SITE_A,
    });
    expect(scopeWhere({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A })).toEqual({ siteId: SITE_A });
  });
});

describe("authorize overload return types", () => {
  it("narrows grant shapes by ref kind", () => {
    const { policy } = buildPolicy();
    expectTypeOf(
      policy.authorize(user(), { permission: "user:read", scope: { kind: "workspace" } }),
    ).resolves.toEqualTypeOf<WorkspaceGrant | PolicyDenial>();
    expectTypeOf(
      policy.authorize(user(), { permission: "user:read", scope: { kind: "anySite" } }),
    ).resolves.toEqualTypeOf<WorkspaceGrant | PolicyDenial>();
    expectTypeOf(
      policy.authorize(user(), { permission: "user:read", scope: { kind: "site", siteId: SITE_A } }),
    ).resolves.toEqualTypeOf<SiteGrant | PolicyDenial>();
    expectTypeOf(
      policy.authorize(user(), { permission: "user:read", scope: { kind: "station", id: STATION } }),
    ).resolves.toEqualTypeOf<SiteGrant | PolicyDenial>();
    expectTypeOf(
      policy.authorize(user(), { permission: "user:read", scope: { kind: "gateway", id: STATION } }),
    ).resolves.toEqualTypeOf<SiteGrant | WorkspaceGrant | PolicyDenial>();
  });
});

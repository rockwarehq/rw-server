import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { AppIAMContext, DisplayIAMContext, IAMBucketSnapshot, IAMContext, UserIAMContext } from "../context.js";
import { completeSnapshotEntries } from "./buckets.js";
import {
  createPolicy,
  type PolicyDenial,
  type PolicyDeps,
  scopeFilter,
  scopeWhere,
  scopeWorkcenterWhere,
  type SiteGrant,
  type WorkspaceGrant,
} from "./policy.js";

const WORKSPACE = "11111111-1111-1111-1111-111111111111";
const SITE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SITE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STATION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLANT_A = "0a000000-0000-4000-8000-000000000001";
const WC_1 = "11111111-1111-4111-8111-111111111111";
const WC_2 = "22222222-2222-4222-8222-222222222222";
const WCB_1 = "0c000000-0000-4000-8000-000000000001";
const WCB_2 = "0c000000-0000-4000-8000-000000000002";

const SITE_BUCKETS = [
  { id: PLANT_A, kind: "PLANT" as const, siteId: SITE_A, workcenterId: null },
  { id: WCB_1, kind: "WORKCENTER" as const, siteId: SITE_A, workcenterId: WC_1 },
  { id: WCB_2, kind: "WORKCENTER" as const, siteId: SITE_A, workcenterId: WC_2 },
];

const snapshotOf = (
  direct: Array<{
    bucketId: string;
    kind: "PLANT" | "WORKCENTER";
    siteId: string;
    workcenterId: string | null;
    tier: "VIEW" | "MANAGE" | "ADMIN";
  }>,
): IAMBucketSnapshot => ({ owner: false, staff: "NONE", entries: completeSnapshotEntries(direct, SITE_BUCKETS) });

const MEMBER = snapshotOf([{ bucketId: PLANT_A, kind: "PLANT", siteId: SITE_A, workcenterId: null, tier: "VIEW" }]);
const MANAGER = snapshotOf([{ bucketId: PLANT_A, kind: "PLANT", siteId: SITE_A, workcenterId: null, tier: "MANAGE" }]);
const ADMIN = snapshotOf([{ bucketId: PLANT_A, kind: "PLANT", siteId: SITE_A, workcenterId: null, tier: "ADMIN" }]);
const CREW = snapshotOf([{ bucketId: WCB_1, kind: "WORKCENTER", siteId: SITE_A, workcenterId: WC_1, tier: "MANAGE" }]);
const OWNER: IAMBucketSnapshot = { owner: true, staff: "NONE", entries: [] };
const SUPPORT: IAMBucketSnapshot = { owner: false, staff: "READ", entries: [] };

const user = (snapshot: IAMBucketSnapshot, overrides: Partial<UserIAMContext> = {}): UserIAMContext => ({
  principal: "USER",
  validToken: true,
  id: "user-1",
  email: "u@test.local",
  workspaceId: WORKSPACE,
  bucketSnapshot: snapshot,
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
    loadBucketSnapshot: vi.fn(async () => MEMBER),
    resolveSiteRef: vi.fn(async () => ({ siteId: SITE_A })),
    ...overrides,
  };
  return { policy: createPolicy(deps), deps };
}

describe("authorize — entry guards", () => {
  it("denies UNAUTHENTICATED when iam is missing or the token is invalid", async () => {
    const { policy } = buildPolicy();
    expect(await policy.authorize(undefined, { tier: "VIEW", scope: { kind: "site", siteId: SITE_A } })).toMatchObject({
      ok: false,
      code: "UNAUTHENTICATED",
    });
    const bad: IAMContext = { principal: "UNKNOWN", validToken: false };
    expect(await policy.authorize(bad, { tier: "VIEW", scope: { kind: "site", siteId: SITE_A } })).toMatchObject({
      ok: false,
      code: "UNAUTHENTICATED",
    });
  });

  it("denies NO_WORKSPACE without workspace context", async () => {
    const { policy } = buildPolicy();
    const result = await policy.authorize(user(MEMBER, { workspaceId: undefined }), {
      tier: "VIEW",
      scope: { kind: "site", siteId: SITE_A },
    });
    expect(result).toMatchObject({ ok: false, code: "NO_WORKSPACE" });
  });
});

describe("authorize — plant things (no workcenter stamp)", () => {
  it("members read, managers write, neither is enough for the other direction", async () => {
    const { policy } = buildPolicy();
    expect(await policy.authorize(user(MEMBER), { tier: "VIEW", scope: { kind: "site", siteId: SITE_A } })).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
      siteId: SITE_A,
    });
    expect(
      await policy.authorize(user(MEMBER), { tier: "MANAGE", scope: { kind: "site", siteId: SITE_A } }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN", tier: "MANAGE" });
    expect(await policy.authorize(user(MANAGER), { tier: "MANAGE", scope: { kind: "site", siteId: SITE_A } })).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
      siteId: SITE_A,
    });
  });

  it("ADMIN is the reserved shelf above MANAGE", async () => {
    const { policy } = buildPolicy();
    expect(
      await policy.authorize(user(MANAGER), { tier: "ADMIN", scope: { kind: "site", siteId: SITE_A } }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await policy.authorize(user(ADMIN), { tier: "ADMIN", scope: { kind: "site", siteId: SITE_A } })).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
      siteId: SITE_A,
    });
  });

  it("is site-sensitive", async () => {
    const { policy } = buildPolicy();
    expect(
      await policy.authorize(user(MEMBER), { tier: "VIEW", scope: { kind: "site", siteId: SITE_B } }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("resolves resource refs through the row locator", async () => {
    const { policy, deps } = buildPolicy();
    const result = await policy.authorize(user(MEMBER), { tier: "VIEW", scope: { kind: "order", id: STATION } });
    expect(result).toEqual({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A });
    expect(deps.resolveSiteRef).toHaveBeenCalledWith({ kind: "order", id: STATION });
  });

  it("returns NOT_FOUND for unresolvable refs", async () => {
    const { policy } = buildPolicy({ resolveSiteRef: vi.fn(async () => null) });
    const result = await policy.authorize(user(MEMBER), { tier: "VIEW", scope: { kind: "station", id: STATION } });
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("authorize — workcenter things (crew buckets)", () => {
  const resolveToWc1 = vi.fn(async () => ({ siteId: SITE_A, workcenterId: WC_1 }));
  const resolveToWc2 = vi.fn(async () => ({ siteId: SITE_A, workcenterId: WC_2 }));

  it("plant members do NOT see the floor; the crew does", async () => {
    const { policy } = buildPolicy({ resolveSiteRef: resolveToWc1 });
    expect(
      await policy.authorize(user(MEMBER), { tier: "VIEW", scope: { kind: "station", id: STATION } }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await policy.authorize(user(CREW), { tier: "VIEW", scope: { kind: "station", id: STATION } })).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
      siteId: SITE_A,
    });
  });

  it("crew MANAGE covers operating AND configuring their own cell, not others", async () => {
    const own = buildPolicy({ resolveSiteRef: resolveToWc1 });
    expect(await own.policy.authorize(user(CREW), { tier: "MANAGE", scope: { kind: "station", id: STATION } })).toEqual(
      { ok: true, workspaceId: WORKSPACE, siteId: SITE_A },
    );
    const other = buildPolicy({ resolveSiteRef: resolveToWc2 });
    expect(
      await other.policy.authorize(user(CREW), { tier: "MANAGE", scope: { kind: "station", id: STATION } }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("plant MANAGE cascades to every cell", async () => {
    const { policy } = buildPolicy({ resolveSiteRef: resolveToWc2 });
    expect(await policy.authorize(user(MANAGER), { tier: "MANAGE", scope: { kind: "station", id: STATION } })).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
      siteId: SITE_A,
    });
  });

  it("a literal site+workcenter ref (create flows) evaluates the target cell", async () => {
    const { policy } = buildPolicy();
    expect(
      await policy.authorize(user(CREW), {
        tier: "MANAGE",
        scope: { kind: "site", siteId: SITE_A, workcenterId: WC_1 },
      }),
    ).toEqual({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A });
    expect(
      await policy.authorize(user(CREW), {
        tier: "MANAGE",
        scope: { kind: "site", siteId: SITE_A, workcenterId: WC_2 },
      }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

describe("authorize — workspace and anySite scopes", () => {
  it("workspace scope is reserved for owners (staff FULL unless ownerOnly)", async () => {
    const { policy } = buildPolicy();
    expect(await policy.authorize(user(OWNER), { tier: "ADMIN", scope: { kind: "workspace" } })).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
    });
    expect(await policy.authorize(user(ADMIN), { tier: "ADMIN", scope: { kind: "workspace" } })).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    const staffFull: IAMBucketSnapshot = { owner: false, staff: "FULL", entries: [] };
    expect(await policy.authorize(user(staffFull), { tier: "ADMIN", scope: { kind: "workspace" } })).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
    });
    expect(
      await policy.authorize(user(staffFull), { tier: "ADMIN", scope: { kind: "workspace" }, ownerOnly: true }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("anySite: reads need any visible site; higher tiers need that tier at some plant", async () => {
    const { policy } = buildPolicy();
    expect(await policy.authorize(user(MEMBER), { tier: "VIEW", scope: { kind: "anySite" } })).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
    });
    expect(await policy.authorize(user(MEMBER), { tier: "MANAGE", scope: { kind: "anySite" } })).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(await policy.authorize(user(MANAGER), { tier: "MANAGE", scope: { kind: "anySite" } })).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
    });
    expect(await policy.authorize(user(MANAGER), { tier: "ADMIN", scope: { kind: "anySite" } })).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(await policy.authorize(user(ADMIN), { tier: "ADMIN", scope: { kind: "anySite" } })).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
    });
  });

  it("null-site rows follow the anySite rule", async () => {
    const { policy } = buildPolicy({ resolveSiteRef: vi.fn(async () => ({ siteId: null })) });
    expect(await policy.authorize(user(MEMBER), { tier: "VIEW", scope: { kind: "gateway", id: STATION } })).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
    });
    expect(await policy.authorize(user(MANAGER), { tier: "MANAGE", scope: { kind: "gateway", id: STATION } })).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
    });
    expect(
      await policy.authorize(user(MEMBER), { tier: "MANAGE", scope: { kind: "gateway", id: STATION } }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

describe("authorize — staff and devices", () => {
  it("SUPPORT reads everywhere and writes nowhere", async () => {
    const { policy } = buildPolicy({ resolveSiteRef: vi.fn(async () => ({ siteId: SITE_A, workcenterId: WC_1 })) });
    expect(await policy.authorize(user(SUPPORT), { tier: "VIEW", scope: { kind: "station", id: STATION } })).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
      siteId: SITE_A,
    });
    expect(
      await policy.authorize(user(SUPPORT), { tier: "MANAGE", scope: { kind: "station", id: STATION } }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("devices are authorized by site binding alone — simple auth layers", async () => {
    const { policy, deps } = buildPolicy();
    for (const iam of [display(), app()]) {
      expect(await policy.authorize(iam, { tier: "MANAGE", scope: { kind: "site", siteId: SITE_A } })).toEqual({
        ok: true,
        workspaceId: WORKSPACE,
        siteId: SITE_A,
      });
      expect(await policy.authorize(iam, { tier: "VIEW", scope: { kind: "site", siteId: SITE_B } })).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
      });
    }
    expect(deps.loadBucketSnapshot).not.toHaveBeenCalled();
  });

  it("devices are denied workspace and anySite scopes", async () => {
    const { policy } = buildPolicy();
    for (const iam of [display(), app()]) {
      expect(await policy.authorize(iam, { tier: "VIEW", scope: { kind: "anySite" } })).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
      });
      expect(await policy.authorize(iam, { tier: "ADMIN", scope: { kind: "workspace" } })).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
      });
    }
  });
});

describe("authorizeList", () => {
  it("PLANT lists: members read site-wide; MANAGE lists need managers", async () => {
    const { policy } = buildPolicy();
    expect(await policy.authorizeList(user(MEMBER, { siteId: SITE_A }), { tier: "VIEW", bucketKind: "PLANT" })).toEqual(
      { ok: true, workspaceId: WORKSPACE, siteId: SITE_A },
    );
    expect(
      await policy.authorizeList(user(MEMBER, { siteId: SITE_A }), { tier: "MANAGE", bucketKind: "PLANT" }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("WORKCENTER lists: crew narrow to their cells; plant managers see the whole floor", async () => {
    const { policy } = buildPolicy();
    expect(
      await policy.authorizeList(user(CREW, { siteId: SITE_A }), { tier: "VIEW", bucketKind: "WORKCENTER" }),
    ).toEqual({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A, workcenterIds: [WC_1] });
    expect(
      await policy.authorizeList(user(MANAGER, { siteId: SITE_A }), { tier: "VIEW", bucketKind: "WORKCENTER" }),
    ).toEqual({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A });
    // Plant members hold no crew bucket: the floor list denies.
    expect(
      await policy.authorizeList(user(MEMBER, { siteId: SITE_A }), { tier: "VIEW", bucketKind: "WORKCENTER" }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("requires a site context and honors an explicit request", async () => {
    const { policy } = buildPolicy();
    expect(await policy.authorizeList(user(MEMBER), { tier: "VIEW", bucketKind: "PLANT" })).toMatchObject({
      ok: false,
      code: "NO_WORKSPACE",
    });
    expect(
      await policy.authorizeList(user(MEMBER), { tier: "VIEW", bucketKind: "PLANT", requestedSiteId: SITE_A }),
    ).toEqual({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A });
  });

  it("devices list within their own site only", async () => {
    const { policy } = buildPolicy();
    expect(await policy.authorizeList(display(), { tier: "VIEW", bucketKind: "WORKCENTER" })).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
      siteId: SITE_A,
    });
    expect(
      await policy.authorizeList(display(), { tier: "VIEW", bucketKind: "WORKCENTER", requestedSiteId: SITE_B }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

describe("authorizeAccessibleSites", () => {
  it("returns membership visibility; owners see all; devices see their site", async () => {
    const { policy } = buildPolicy();
    expect(await policy.authorizeAccessibleSites(user(CREW))).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
      siteIds: [SITE_A],
    });
    expect(await policy.authorizeAccessibleSites(user(OWNER))).toEqual({ ok: true, workspaceId: WORKSPACE });
    expect(await policy.authorizeAccessibleSites(display())).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
      siteIds: [SITE_A],
    });
  });
});

describe("scope helpers", () => {
  it("produce single-site fragments; workcenter narrowing keeps site-level rows readable", () => {
    expect(scopeFilter({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A })).toEqual({
      workspaceId: WORKSPACE,
      siteId: SITE_A,
    });
    expect(scopeWhere({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A })).toEqual({ siteId: SITE_A });
    expect(scopeWorkcenterWhere({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A, workcenterIds: [WC_1] })).toEqual({
      OR: [{ workcenterId: { in: [WC_1] } }, { workcenterId: null }],
    });
    expect(scopeWorkcenterWhere({ ok: true, workspaceId: WORKSPACE, siteId: SITE_A })).toEqual({});
  });
});

describe("authorize overload return types", () => {
  it("narrows grant shapes by ref kind", () => {
    const { policy } = buildPolicy();
    expectTypeOf(policy.authorize(user(OWNER), { tier: "ADMIN", scope: { kind: "workspace" } })).resolves.toEqualTypeOf<
      WorkspaceGrant | PolicyDenial
    >();
    expectTypeOf(policy.authorize(user(MEMBER), { tier: "VIEW", scope: { kind: "anySite" } })).resolves.toEqualTypeOf<
      WorkspaceGrant | PolicyDenial
    >();
    expectTypeOf(
      policy.authorize(user(MEMBER), { tier: "VIEW", scope: { kind: "site", siteId: SITE_A } }),
    ).resolves.toEqualTypeOf<SiteGrant | PolicyDenial>();
    expectTypeOf(
      policy.authorize(user(MEMBER), { tier: "VIEW", scope: { kind: "station", id: STATION } }),
    ).resolves.toEqualTypeOf<SiteGrant | PolicyDenial>();
    expectTypeOf(
      policy.authorize(user(MEMBER), { tier: "VIEW", scope: { kind: "gateway", id: STATION } }),
    ).resolves.toEqualTypeOf<SiteGrant | WorkspaceGrant | PolicyDenial>();
  });
});

import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadUserCurrent } from "../src/auth/plugin.js";
import { router } from "../src/rpc/index.js";
import type { SetupPlan } from "../src/setup/plan.js";
import { makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

// Setup changesets: plan by external key, apply in one transaction, re-runs
// come back unchanged, the plant moving under a reviewed plan is refused, and
// a connected agent can propose but never apply.

const MEMBER = { email: "setup-member@test.local", password: "setup-member-password-1" };
const VIEWER = { email: "setup-viewer@test.local", password: "setup-viewer-password-1" };
const RUN = `t${Date.now().toString(36)}`;
const SOURCE = `test-erp-${RUN}`;

const spec = (overrides: { productName?: string } = {}) => ({
  source: SOURCE,
  materials: [
    { key: `RES-${RUN}`, name: `PP Homopolymer ${RUN}`, weightUnits: "KG" },
    { key: `CLR-${RUN}`, name: `Black masterbatch ${RUN}`, weightUnits: "KG" },
  ],
  products: [
    {
      key: `P1-${RUN}`,
      name: overrides.productName ?? `Cap 38mm ${RUN}`,
      weight: 4.2,
      weightUnits: "G",
      materials: [
        { material: `RES-${RUN}`, weight: 4.1, weightUnits: "G" },
        { material: `CLR-${RUN}`, weight: 0.1, weightUnits: "G" },
      ],
    },
    { key: `P2-${RUN}`, name: `Closure ${RUN}` },
  ],
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("setup changesets (Tier 2)", () => {
  let server: TestServer;
  let siteId: string;
  let memberToken: string;
  let viewerToken: string;

  async function siteToken(email: string, password: string) {
    const login = await loginAs(server, email, password);
    const switched = await server.inject({
      method: "POST",
      url: "/auth/switch-site",
      headers: { authorization: `Bearer ${login.accessToken}` },
      payload: { siteId },
    });
    return (switched.json() as { accessToken: string }).accessToken;
  }

  async function propose(body: unknown, token = memberToken) {
    return rpcCall(server, "setup/changeset/create", { siteId, title: "test import", spec: body }, token);
  }

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    siteId = (await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true } })).id;
    await makeUser(MEMBER.email, MEMBER.password, { plants: [{ siteId, level: "MANAGE" }] });
    await makeUser(VIEWER.email, VIEWER.password, { plants: [{ siteId, level: "VIEW" }] });
    memberToken = await siteToken(MEMBER.email, MEMBER.password);
    viewerToken = await siteToken(VIEWER.email, VIEWER.password);
  }, 30_000);

  afterAll(async () => {
    await prisma.externalRef.deleteMany({ where: { source: SOURCE } });
    await prisma.setupChangeset.deleteMany({ where: { source: SOURCE } });
    await prisma.user.deleteMany({ where: { email: { in: [MEMBER.email, VIEWER.email] } } });
    await server.close();
  });

  it("needs MANAGE to propose", async () => {
    expect((await propose(spec(), viewerToken)).statusCode).toBe(403);
  });

  it("plans creates, applies them in one go, and a re-run comes back unchanged", async () => {
    const proposed = await propose(spec());
    expect(proposed.statusCode).toBe(200);
    const { id, plan } = proposed.json as { id: string; plan: SetupPlan };
    expect(plan.applicable).toBe(true);
    expect(plan.summary).toMatchObject({ material: { create: 2 }, product: { create: 2 } });
    const cap = plan.rows.find((row) => row.key === `P1-${RUN}`);
    expect(cap?.links?.map((link) => link.action)).toEqual(["create", "create"]);

    const applied = await rpcCall(server, "setup/changeset/apply", { id }, memberToken);
    expect(applied.statusCode).toBe(200);

    const product = await prisma.product.findFirstOrThrow({
      where: { siteId, currentVersion: { sku: `P1-${RUN}` } },
      include: { currentVersion: true, materials: true },
    });
    expect(product.currentVersion?.name).toBe(`Cap 38mm ${RUN}`);
    expect(product.materials).toHaveLength(2);
    expect(await prisma.externalRef.count({ where: { source: SOURCE } })).toBe(4);
    expect(
      await prisma.auditLog.count({ where: { action: "SETUP_CHANGESET_APPLIED", metadata: { path: ["changesetId"], equals: id } } }),
    ).toBe(1);

    // Already up to date: planned, but not saved for anyone to review.
    const saved = await prisma.setupChangeset.count({ where: { source: SOURCE } });
    const again = await propose(spec());
    const rerun = again.json as { id: string | null; plan: SetupPlan };
    expect(rerun.id).toBeNull();
    expect(rerun.plan.summary.material).toMatchObject({ create: 0, update: 0, unchanged: 2 });
    expect(rerun.plan.summary.product).toMatchObject({ create: 0, update: 0, unchanged: 2 });
    expect(await prisma.setupChangeset.count({ where: { source: SOURCE } })).toBe(saved);
  });

  it("plans a changed field as an update with its diff", async () => {
    const proposed = await propose(spec({ productName: `Cap 38mm v2 ${RUN}` }));
    const plan = (proposed.json as { plan: SetupPlan }).plan;
    const cap = plan.rows.find((row) => row.key === `P1-${RUN}`);
    expect(cap).toMatchObject({ action: "update", matchedBy: "ref" });
    expect(cap?.changes).toEqual([{ field: "name", from: `Cap 38mm ${RUN}`, to: `Cap 38mm v2 ${RUN}` }]);
  });

  it("finds a record made by hand through its natural key", async () => {
    const sku = `HAND-${RUN}`;
    await rpcCall(server, "product/create", { siteId, sku, name: "Made by hand" }, memberToken);
    const proposed = await propose({ source: SOURCE, products: [{ key: sku, name: "Made by hand" }] });
    const row = (proposed.json as { plan: SetupPlan }).plan.rows[0];
    expect(row).toMatchObject({ action: "unchanged", matchedBy: "natural" });
  });

  it("reports duplicates and unknown materials instead of guessing", async () => {
    const proposed = await propose({
      source: SOURCE,
      materials: [
        { key: `DUP-${RUN}`, name: "a" },
        { key: `DUP-${RUN}`, name: "b" },
      ],
      products: [{ key: `P3-${RUN}`, materials: [{ material: `NOPE-${RUN}` }] }],
    });
    const plan = (proposed.json as { plan: SetupPlan }).plan;
    expect(plan.applicable).toBe(false);
    const codes = plan.rows.flatMap((row) => row.issues.map((issue) => issue.code));
    expect(codes).toContain("DUPLICATE_KEY");
    expect(codes).toContain("UNKNOWN_MATERIAL");

    const id = (proposed.json as { id: string }).id;
    const applied = await rpcCall(server, "setup/changeset/apply", { id }, memberToken);
    expect(applied.statusCode).toBe(400);
  });

  it("refuses to apply a plan the plant has moved away from, and keeps the fresh plan", async () => {
    const proposed = await propose(spec({ productName: `Cap stale ${RUN}` }));
    const { id } = proposed.json as { id: string };
    const product = await prisma.product.findFirstOrThrow({ where: { siteId, currentVersion: { sku: `P1-${RUN}` } } });
    await rpcCall(server, "product/update", { id: product.id, name: `Renamed in IMM ${RUN}` }, memberToken);

    const applied = await rpcCall(server, "setup/changeset/apply", { id }, memberToken);
    expect(applied.statusCode).toBe(409);
    const after = await rpcCall(server, "setup/changeset/get", { id }, memberToken);
    const body = after.json as { status: string; plan: SetupPlan };
    expect(body.status).toBe("DRAFT");
    const cap = body.plan.rows.find((row) => row.key === `P1-${RUN}`);
    expect(cap?.changes[0]).toMatchObject({ from: `Renamed in IMM ${RUN}`, to: `Cap stale ${RUN}` });
  });

  it("lets a connected agent propose and revise, never apply", async () => {
    const person = await prisma.user.findUniqueOrThrow({ where: { email: MEMBER.email }, select: { id: true } });
    const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { workspaceId: true } });
    const current = await loadUserCurrent(person.id, site.workspaceId, siteId);
    if (current?.kind !== "user") throw new Error("expected a user");
    const client = (scopes: string[]) =>
      createRouterClient(router, {
        context: {
          request: { headers: {} },
          current: { ...current, via: { kind: "oauth" as const, grantId: randomUUID(), clientId: "c", clientName: "Claude Code", scopes } },
          access: current.access,
        },
      });

    await expect(
      client(["read"]).setup.changeset.create({ siteId, title: "read only", spec: spec() as never }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const agent = client(["read", "setup:propose"]);
    const proposal = await agent.setup.changeset.create({
      siteId,
      title: "from an agent",
      spec: spec({ productName: `Cap from an agent ${RUN}` }) as never,
    });
    if (!proposal.id) throw new Error("expected a saved proposal");
    const created = { id: proposal.id };
    const row = await prisma.setupChangeset.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ author: "AGENT", clientName: "Claude Code" });

    await expect(agent.setup.changeset.replan({ id: created.id })).resolves.toBeDefined();
    await expect(agent.setup.changeset.apply({ id: created.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const detail = await agent.setup.changeset.get({ id: created.id });
    expect(detail.canApply).toBe(false);
  });
});

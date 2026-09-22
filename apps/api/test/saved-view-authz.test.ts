import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const suffix = randomUUID();
const password = "SavedViewFixture123!";
const siteId = randomUUID();
const otherSiteId = randomUUID();
const foreignSiteId = randomUUID();
const foreignWorkspaceId = randomUUID();
const workcenterId = randomUUID();
const siblingWorkcenterId = randomUUID();
const otherWorkcenterId = randomUUID();
const foreignWorkcenterId = randomUUID();
const stationId = randomUUID();
const siblingStationId = randomUUID();
const otherStationId = randomUUID();
const foreignStationId = randomUUID();
const memberId = randomUUID();
const peerId = randomUUID();
const engineerId = randomUUID();
const planningOnlyId = randomUUID();
const labelId = randomUUID();
const otherLabelId = randomUUID();
const sites = [siteId, otherSiteId, foreignSiteId];

const cycleConfig = { range: "today", quietGoodCycles: true };
const shiftConfig = {
  stationIds: null, labelIds: null, stationsLayout: "list", chartMode: "production",
  showChart: true, showKpis: true, wcKpiVisibility: {}, stationPropertyVisibility: {},
};
const timelineConfig = {
  layers: { jobs: true, downtime: true, shifts: true, andon: true }, stationIds: null, labelIds: null,
};

type View = { id: string; name: string; page: string; scopeId: string | null; visibility: string; config: Record<string, unknown> };

describe.skipIf(!process.env.TEST_DATABASE_URL)("saved view authorization (Tier 2)", () => {
  let server: TestServer;
  let memberToken: string;
  let peerToken: string;
  let engineerToken: string;
  let planningOnlyToken: string;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: "default" }, select: { id: true } });
    await prisma.workspace.create({ data: { id: foreignWorkspaceId, name: `Saved view foreign ${suffix}`, slug: `sv-foreign-${suffix}` } });
    await prisma.site.createMany({ data: [
      { id: siteId, workspaceId: workspace.id, name: `Saved view A ${suffix}` },
      { id: otherSiteId, workspaceId: workspace.id, name: `Saved view B ${suffix}` },
      { id: foreignSiteId, workspaceId: foreignWorkspaceId, name: `Saved view foreign ${suffix}` },
    ] });
    await prisma.workcenter.createMany({ data: [
      { id: workcenterId, siteId, name: "Granted workcenter" },
      { id: siblingWorkcenterId, siteId, name: "Ungranted workcenter" },
      { id: otherWorkcenterId, siteId: otherSiteId, name: "Other plant workcenter" },
      { id: foreignWorkcenterId, siteId: foreignSiteId, name: "Foreign company workcenter" },
    ] });
    await prisma.station.createMany({ data: [
      { id: stationId, siteId, workcenterId, name: "Granted station" },
      { id: siblingStationId, siteId, workcenterId: siblingWorkcenterId, name: "Ungranted station" },
      { id: otherStationId, siteId: otherSiteId, workcenterId: otherWorkcenterId, name: "Other plant station" },
      { id: foreignStationId, siteId: foreignSiteId, workcenterId: foreignWorkcenterId, name: "Foreign company station" },
    ] });
    await prisma.label.createMany({ data: [
      { id: labelId, siteId, name: "Local reference" },
      { id: otherLabelId, siteId: otherSiteId, name: "Foreign reference" },
    ] });
    const memberRole = await prisma.role.findUniqueOrThrow({
      where: { workspaceId_name_scope: { workspaceId: workspace.id, name: "Plant Member", scope: "SITE" } },
    });
    const engineerRole = await prisma.role.findUniqueOrThrow({
      where: { workspaceId_name_scope: { workspaceId: workspace.id, name: "Plant Engineer", scope: "SITE" } },
    });
    const passwordHash = await hashPassword(password);
    for (const id of [memberId, peerId, engineerId, planningOnlyId]) {
      await prisma.user.create({ data: { id, email: `sv-${id}@test.local`, status: "ACTIVE", passwordHash } });
      const membership = await prisma.workspaceMembership.create({ data: { userId: id, workspaceId: workspace.id } });
      await prisma.roleAssignment.create({
        data: { membershipId: membership.id, roleId: id === engineerId ? engineerRole.id : memberRole.id, siteId },
      });
      if (id === memberId || id === peerId) {
        await prisma.workcenterGrant.create({ data: { membershipId: membership.id, workcenterId, access: "READ" } });
      }
    }
    memberToken = (await loginAs(server, `sv-${memberId}@test.local`, password)).accessToken;
    peerToken = (await loginAs(server, `sv-${peerId}@test.local`, password)).accessToken;
    engineerToken = (await loginAs(server, `sv-${engineerId}@test.local`, password)).accessToken;
    planningOnlyToken = (await loginAs(server, `sv-${planningOnlyId}@test.local`, password)).accessToken;
  }, 30_000);

  afterAll(async () => {
    try {
      await prisma.savedView.deleteMany({ where: { siteId: { in: sites } } });
      await prisma.user.deleteMany({ where: { id: { in: [memberId, peerId, engineerId, planningOnlyId] } } });
      await prisma.station.deleteMany({ where: { siteId: { in: sites } } });
      await prisma.workcenter.deleteMany({ where: { siteId: { in: sites } } });
      await prisma.site.deleteMany({ where: { id: { in: sites } } });
      await prisma.workspace.deleteMany({ where: { id: foreignWorkspaceId } });
    } finally {
      await server?.close();
    }
  });

  const call = (verb: string, input: unknown, token = memberToken) => rpcCall(server, `savedView/${verb}`, input, token);
  const privateCycleInput = () => ({ siteId, page: "station-cycles", scopeId: stationId, name: "My cycles", visibility: "PRIVATE", config: cycleConfig });
  async function createPrivate() {
    const created = await call("create", privateCycleInput());
    expect(created.statusCode).toBe(200);
    return created.json as View;
  }

  it.each([
    { page: "station-cycles", scopeId: stationId, config: cycleConfig },
    { page: "shift-view", scopeId: workcenterId, config: shiftConfig },
    { page: "timeline", scopeId: workcenterId, config: timelineConfig },
    { page: "stations-directory", scopeId: null, config: { columns: ["name", "status"] } },
  ])("a Plant Member with READ at one workcenter can create/update/delete its PRIVATE $page view", async (context) => {
    const created = await call("create", { ...context, siteId, name: "Personal", visibility: "PRIVATE" });
    expect(created.statusCode).toBe(200);
    const view = created.json as View;
    const updated = await call("update", { id: view.id, page: context.page, name: "Personal updated", config: context.config });
    expect(updated.statusCode).toBe(200);
    expect(updated.json).toMatchObject({ id: view.id, name: "Personal updated", visibility: "PRIVATE" });
    const listed = await call("list", { siteId, page: context.page, scopeId: context.scopeId });
    expect(listed.statusCode).toBe(200);
    expect((listed.json as { data: View[] }).data.map((v) => v.id)).toContain(view.id);
    expect((await call("delete", { id: view.id })).statusCode).toBe(200);
    expect((await prisma.savedView.findUniqueOrThrow({ where: { id: view.id } })).deletedAt).not.toBeNull();
  });

  it("preserves opaque stations-directory namespaces and optional site-context defaults", async () => {
    for (const context of [
      { page: "stations-directory", scopeId: randomUUID(), config: { columns: ["name"] } },
      { page: "timeline", scopeId: null, config: timelineConfig },
      { page: "station-cycles", scopeId: null, config: cycleConfig },
    ]) {
      const created = await call("create", { ...context, siteId, name: "Default", visibility: "PRIVATE" });
      expect(created.statusCode).toBe(200);
      const listed = await call("list", { siteId, page: context.page, scopeId: context.scopeId });
      expect(listed.statusCode).toBe(200);
      expect((listed.json as { data: View[] }).data.map((v) => v.id)).toContain((created.json as View).id);
    }
  });

  it("private views are invisible and immutable to other readers, including engineers", async () => {
    const view = await createPrivate();
    for (const token of [peerToken, engineerToken]) {
      const listed = await call("list", { siteId, page: view.page, scopeId: stationId }, token);
      expect(listed.statusCode).toBe(200);
      expect((listed.json as { data: View[] }).data.map((v) => v.id)).not.toContain(view.id);
      expect((await call("update", { id: view.id, page: view.page, config: { ...cycleConfig, range: "24h" } }, token)).statusCode).toBe(403);
      expect((await call("delete", { id: view.id }, token)).statusCode).toBe(403);
    }
    expect((await prisma.savedView.findUniqueOrThrow({ where: { id: view.id } })).config).toEqual(cycleConfig);
  });

  it("a private owner cannot create or publish shared defaults without site configuration authority", async () => {
    expect((await call("create", { ...privateCycleInput(), visibility: "WORKSPACE" })).statusCode).toBe(403);
    const view = await createPrivate();
    expect((await call("update", { id: view.id, page: view.page, visibility: "WORKSPACE" })).statusCode).toBe(403);
    expect((await call("update", { id: view.id, page: "stations-directory", visibility: "WORKSPACE", config: { columns: [] } })).statusCode).toBe(400);
    expect((await prisma.savedView.findUniqueOrThrow({ where: { id: view.id } })).visibility).toBe("PRIVATE");
  });

  it("an engineer can publish its own private default and delete the resulting shared view", async () => {
    const created = await call("create", privateCycleInput(), engineerToken);
    expect(created.statusCode).toBe(200);
    const view = created.json as View;
    const published = await call("update", { id: view.id, page: view.page, visibility: "WORKSPACE" }, engineerToken);
    expect(published.statusCode).toBe(200);
    expect(published.json).toMatchObject({ id: view.id, visibility: "WORKSPACE" });
    const listed = await call("list", { siteId, page: view.page, scopeId: stationId });
    expect(listed.statusCode).toBe(200);
    expect((listed.json as { data: View[] }).data.map((v) => v.id)).toContain(view.id);
    expect((await call("delete", { id: view.id }, engineerToken)).statusCode).toBe(200);
  });

  it("shared defaults are readable in scope, while publishing and shared identity/delete rules remain guarded", async () => {
    const created = await call("create", { ...privateCycleInput(), visibility: "WORKSPACE", name: "Shared" }, engineerToken);
    expect(created.statusCode).toBe(200);
    const view = created.json as View;
    const listed = await call("list", { siteId, page: view.page, scopeId: stationId });
    expect(listed.statusCode).toBe(200);
    expect((listed.json as { data: View[] }).data.map((v) => v.id)).toContain(view.id);
    expect((await call("update", { id: view.id, page: view.page, config: { ...cycleConfig, range: "24h" } })).statusCode).toBe(403);
    expect((await call("update", { id: view.id, page: view.page, visibility: "PRIVATE" })).statusCode).toBe(403);
    expect((await call("delete", { id: view.id })).statusCode).toBe(403);

    // A previously published view with a different creator remains editable as
    // shared configuration, but an engineer cannot take over its identity.
    await prisma.savedView.update({ where: { id: view.id }, data: { createdById: peerId } });
    expect((await call("update", { id: view.id, page: view.page, config: { ...cycleConfig, range: "24h" } }, engineerToken)).statusCode).toBe(200);
    expect((await call("update", { id: view.id, page: view.page, name: "Taken over" }, engineerToken)).statusCode).toBe(403);
    expect((await call("update", { id: view.id, page: view.page, visibility: "PRIVATE" }, engineerToken)).statusCode).toBe(403);
    expect((await call("delete", { id: view.id }, engineerToken)).statusCode).toBe(403);
  });

  it("planning-only membership does not imply read access to live production views", async () => {
    expect((await call("create", privateCycleInput(), planningOnlyToken)).statusCode).toBe(403);
    expect((await call("list", { siteId, page: "stations-directory" }, planningOnlyToken)).statusCode).toBe(403);
  });

  it.each([
    { page: "station-cycles", scopeId: siblingStationId, config: cycleConfig, status: 403 },
    { page: "station-cycles", scopeId: otherStationId, config: cycleConfig, status: 403 },
    { page: "station-cycles", scopeId: foreignStationId, config: cycleConfig, status: 403 },
    { page: "shift-view", scopeId: siblingWorkcenterId, config: shiftConfig, status: 403 },
    { page: "timeline", scopeId: otherWorkcenterId, config: timelineConfig, status: 403 },
    { page: "station-cycles", scopeId: workcenterId, config: cycleConfig, status: 404 },
    { page: "shift-view", scopeId: stationId, config: shiftConfig, status: 404 },
  ])("validates the actual $page scope $scopeId for both creation and reading", async ({ status, ...context }) => {
    expect((await call("create", { ...context, siteId, name: "Invalid scope", visibility: "PRIVATE" })).statusCode).toBe(status);
    expect((await call("list", { siteId, page: context.page, scopeId: context.scopeId })).statusCode).toBe(status);
  });

  it("does not trust a site's claimed relationship to an otherwise authorized scope", async () => {
    expect((await call("create", { ...privateCycleInput(), siteId: otherSiteId })).statusCode).toBe(403);
    expect((await call("list", { siteId: otherSiteId, page: "shift-view", scopeId: workcenterId })).statusCode).toBe(403);
  });

  it("validates selected stations and labels against the accessible view context", async () => {
    for (const config of [
      { ...shiftConfig, stationIds: [siblingStationId] },
      { ...shiftConfig, stationIds: [otherStationId] },
      { ...shiftConfig, labelIds: [otherLabelId] },
    ]) {
      expect((await call("create", { siteId, page: "shift-view", scopeId: workcenterId, name: "Foreign filter", visibility: "PRIVATE", config })).statusCode).toBe(403);
    }
    const created = await call("create", {
      siteId, page: "shift-view", scopeId: workcenterId, name: "Local filters", visibility: "PRIVATE",
      config: { ...shiftConfig, stationIds: [stationId], labelIds: [labelId] },
    });
    expect(created.statusCode).toBe(200);
    const view = created.json as View;
    expect((await call("update", { id: view.id, page: view.page, config: { ...shiftConfig, stationIds: [siblingStationId] } })).statusCode).toBe(403);
    expect((await prisma.savedView.findUniqueOrThrow({ where: { id: view.id } })).config).toEqual(view.config);
  });

  it("mutation authorization uses stored scope and page instead of caller claims", async () => {
    const inaccessible = await prisma.savedView.create({ data: {
      ...privateCycleInput(), scopeId: siblingStationId, createdById: memberId,
    } });
    expect((await call("update", { id: inaccessible.id, page: "station-cycles", name: "Out of scope" })).statusCode).toBe(403);
    expect((await call("update", { id: inaccessible.id, page: "stations-directory", config: { columns: [] } })).statusCode).toBe(400);
    expect((await call("delete", { id: inaccessible.id })).statusCode).toBe(403);

    const own = await createPrivate();
    expect((await call("update", { id: own.id, page: "timeline", config: timelineConfig })).statusCode).toBe(400);
    expect((await prisma.savedView.findUniqueOrThrow({ where: { id: own.id } })).config).toEqual(cycleConfig);
  });

  it("creator identity cannot bypass the saved view's actual workspace", async () => {
    const foreign = await prisma.savedView.create({ data: {
      ...privateCycleInput(), siteId: foreignSiteId, scopeId: foreignStationId, createdById: memberId,
    } });
    expect((await call("update", { id: foreign.id, page: foreign.page, name: "Foreign" })).statusCode).toBe(403);
    expect((await call("delete", { id: foreign.id })).statusCode).toBe(403);
  });
});

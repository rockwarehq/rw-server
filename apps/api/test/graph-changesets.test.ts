import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const ADMIN_EMAIL = "changeset-admin@test.local";
const VIEWER_EMAIL = "changeset-viewer@test.local";
const PASSWORD = "changeset-password-1";
const PREFIX = `cs-${Date.now()}`;

const symbol = (id: string) => `p_${id.replaceAll("-", "_")}`;

interface Changeset {
  id: string;
  status: string;
  graphVersion: unknown;
  planResult: { valid: boolean; issues: unknown[] };
  appliedResult: { nodes: Record<string, string>; properties: string[]; hooks: string[] } | null;
}

// Tier 2: changesets plan on create, apply in one transaction, refuse when
// stale or invalid, and are admin-only to write.
describe.skipIf(!process.env.TEST_DATABASE_URL)("graph changesets (Tier 2)", () => {
  let server: TestServer;
  let siteId: string;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    const site = await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true } });
    siteId = site.id;
    await makeUser(ADMIN_EMAIL, PASSWORD, { plants: [{ siteId, level: "ADMIN" }] });
    await makeUser(VIEWER_EMAIL, PASSWORD, { plants: [{ siteId, level: "VIEW" }] });
    adminToken = (await loginAs(server, ADMIN_EMAIL, PASSWORD)).accessToken;
    viewerToken = (await loginAs(server, VIEWER_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.graphChangeset.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.graphHook.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.graphNode.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { in: [ADMIN_EMAIL, VIEWER_EMAIL] } } });
    await server.close();
  });

  function spec(tag: string) {
    const base = randomUUID();
    const doubled = randomUUID();
    return {
      ids: { base, doubled },
      body: {
        siteId,
        title: `${PREFIX} ${tag}`,
        nodes: [{ ref: "n", name: `${PREFIX}-${tag}` }],
        properties: [
          { id: base, nodeRef: "n", name: "base", resolverType: "expr", resolver: { expression: "2 + 3" } },
          {
            id: doubled,
            nodeRef: "n",
            name: "doubled",
            resolverType: "expr",
            resolver: { expression: `${symbol(base)} * 2` },
          },
        ],
        hooks: [
          {
            name: `${PREFIX}-${tag}-hook`,
            condition: { source: { type: "property", propertyId: doubled }, operator: "changed" },
            eventNamespace: "livestore",
            eventName: "hook_triggered",
          },
        ],
      },
    };
  }

  it("creates a planned draft and applies every item in one go", async () => {
    const { ids, body } = spec("apply");
    const created = await rpcCall(server, "graph/changeset/create", body, adminToken);
    expect(created.statusCode).toBe(200);
    const draft = created.json as Changeset;
    expect(draft.status).toBe("DRAFT");
    expect(draft.planResult.valid).toBe(true);

    const applied = await rpcCall(
      server,
      "graph/changeset/apply",
      { siteId, id: draft.id, expectedGraphVersion: draft.graphVersion },
      adminToken,
    );
    expect(applied.statusCode).toBe(200);
    const result = applied.json as Changeset;
    expect(result.status).toBe("APPLIED");
    expect(result.appliedResult?.properties).toEqual([ids.base, ids.doubled]);

    const node = await prisma.graphNode.findFirstOrThrow({
      where: { siteId, name: `${PREFIX}-apply` },
      include: { properties: true },
    });
    expect(node.properties.map((p) => p.name).sort()).toEqual(["base", "doubled"]);
    const edge = await prisma.graphEdge.findFirst({ where: { fromPropertyId: ids.base, toPropertyId: ids.doubled } });
    expect(edge).not.toBeNull();
    expect(await prisma.graphHook.count({ where: { name: `${PREFIX}-apply-hook` } })).toBe(1);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "GRAPH_CHANGESET_APPLIED", metadata: { path: ["changesetId"], equals: draft.id } },
    });
    expect(audit).not.toBeNull();

    const again = await rpcCall(server, "graph/changeset/apply", { siteId, id: draft.id }, adminToken);
    expect(again.statusCode).toBe(409);
  });

  it("refuses a stale changeset and writes nothing", async () => {
    const { body } = spec("stale");
    const draft = (await rpcCall(server, "graph/changeset/create", body, adminToken)).json as Changeset;

    // Someone edits the graph between review and apply.
    const moved = await rpcCall(server, "graph/node/create", { siteId, name: `${PREFIX}-mover` }, adminToken);
    expect(moved.statusCode).toBe(200);

    const applied = await rpcCall(
      server,
      "graph/changeset/apply",
      { siteId, id: draft.id, expectedGraphVersion: draft.graphVersion },
      adminToken,
    );
    expect(applied.statusCode).toBe(409);
    expect(await prisma.graphNode.count({ where: { siteId, name: `${PREFIX}-stale`, isDeleted: false } })).toBe(0);

    // Re-reviewing (replan) refreshes the version, and then it applies.
    const replanned = (await rpcCall(server, "graph/changeset/replan", { siteId, id: draft.id }, adminToken))
      .json as Changeset;
    const retry = await rpcCall(
      server,
      "graph/changeset/apply",
      { siteId, id: draft.id, expectedGraphVersion: replanned.graphVersion },
      adminToken,
    );
    expect(retry.statusCode).toBe(200);
  });

  it("refuses an invalid changeset and writes nothing", async () => {
    const { body } = spec("invalid");
    body.properties[1].resolver = { expression: `${symbol(randomUUID())} * 2` };
    const draft = (await rpcCall(server, "graph/changeset/create", body, adminToken)).json as Changeset;
    expect(draft.planResult.valid).toBe(false);

    const applied = await rpcCall(server, "graph/changeset/apply", { siteId, id: draft.id }, adminToken);
    expect(applied.statusCode).toBe(400);
    expect(await prisma.graphNode.count({ where: { siteId, name: `${PREFIX}-invalid`, isDeleted: false } })).toBe(0);
  });

  it("lets plant members read changesets but not create, apply or discard them", async () => {
    const { body } = spec("viewer");
    const draft = (await rpcCall(server, "graph/changeset/create", body, adminToken)).json as Changeset;

    expect((await rpcCall(server, "graph/changeset/list", { siteId }, viewerToken)).statusCode).toBe(200);
    expect((await rpcCall(server, "graph/changeset/get", { siteId, id: draft.id }, viewerToken)).statusCode).toBe(200);
    expect((await rpcCall(server, "graph/changeset/create", body, viewerToken)).statusCode).toBe(403);
    expect((await rpcCall(server, "graph/changeset/apply", { siteId, id: draft.id }, viewerToken)).statusCode).toBe(
      403,
    );
    expect(
      (await rpcCall(server, "graph/changeset/discard", { siteId, id: draft.id }, viewerToken)).statusCode,
    ).toBe(403);

    const discarded = await rpcCall(server, "graph/changeset/discard", { siteId, id: draft.id }, adminToken);
    expect((discarded.json as Changeset).status).toBe("DISCARDED");
  });
});

import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePlantBucket, makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const FA_EMAIL = "graph-authz-fa@test.local";
const OFFICE_EMAIL = "graph-authz-office@test.local";
const PASSWORD = "graph-authz-password-1";

// Tier 2: graph, entity (token-site model), and integration enforcement.
describe.skipIf(!process.env.TEST_DATABASE_URL)("graph/entity/integration authorization (Tier 2)", () => {
  let server: TestServer;
  let siteA: { id: string };
  let siteB: { id: string };
  let workspaceToken: string;
  let officeToken: string;
  let siteToken: string;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const rockware = await prisma.site.findFirstOrThrow({
      where: { name: "Rockware" },
      select: { id: true, workspaceId: true },
    });
    siteA = { id: rockware.id };
    const workspaceId = rockware.workspaceId;
    siteB = await prisma.site.upsert({
      where: { workspaceId_name: { workspaceId, name: "GraphAuthZ Site B" } },
      update: {},
      create: { name: "GraphAuthZ Site B", workspaceId },
      select: { id: true },
    });
    await ensurePlantBucket(workspaceId, siteB.id, "GraphAuthZ Site B");

    // Bucket-era fixtures. The author is plant ADMIN at site A (was the
    // "Plant Admin" role). FLIP: graph reads are member reads now (node
    // list was production:read) — the office viewer needs only plant VIEW
    // at site A, where the key model required a custom production:read role.
    await makeUser(workspaceId, FA_EMAIL, PASSWORD, { plants: [{ siteId: siteA.id, tier: "ADMIN" }] });
    await makeUser(workspaceId, OFFICE_EMAIL, PASSWORD, { plants: [{ siteId: siteA.id, tier: "VIEW" }] });

    officeToken = (await loginAs(server, OFFICE_EMAIL, PASSWORD)).accessToken;
    workspaceToken = (await loginAs(server, FA_EMAIL, PASSWORD)).accessToken;
    const switched = await server.inject({
      method: "POST",
      url: "/auth/switch-site",
      headers: { authorization: `Bearer ${workspaceToken}` },
      payload: { siteId: siteA.id },
    });
    expect(switched.statusCode).toBe(200);
    siteToken = (switched.json() as { accessToken: string }).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [FA_EMAIL, OFFICE_EMAIL] } } });
    await prisma.site.deleteMany({ where: { name: "GraphAuthZ Site B" } });
    await server.close();
  });

  it("graph reads allow the granted site and deny the other", async () => {
    const allowed = await rpcCall(server, "graph/node/list", { siteId: siteA.id }, workspaceToken);
    expect(allowed.statusCode).toBe(200);
    const denied = await rpcCall(server, "graph/node/list", { siteId: siteB.id }, workspaceToken);
    expect(denied.statusCode).toBe(403);
  });

  it("graph writes deny cross-site creation", async () => {
    const res = await rpcCall(server, "graph/node/create", { siteId: siteB.id, name: "authz-node" }, workspaceToken);
    expect(res.statusCode).toBe(403);
  });

  it("graph refs resolve unknown ids to NOT_FOUND before permission checks", async () => {
    const res = await rpcCall(server, "graph/node/get", { id: "00000000-0000-4000-8000-000000000002" }, workspaceToken);
    expect(res.statusCode).toBe(404);
  });

  it("entity procedures work with a site-bound token", async () => {
    const res = await rpcCall(server, "entity/model/list", {}, siteToken);
    expect(res.statusCode).toBe(200);
  });

  it("integration reads and destructive ops are open to plant ADMIN (MANAGE and up)", async () => {
    const list = await rpcCall(server, "integration/list", { siteId: siteA.id }, workspaceToken);
    expect(list.statusCode).toBe(200);
    // Plant ADMIN outranks the MANAGE tier the delete demands — the gate
    // passes and the nonexistent id falls through to NOT_FOUND instead of
    // FORBIDDEN.
    const del = await rpcCall(
      server,
      "integration/delete",
      { id: "00000000-0000-4000-8000-000000000009", siteId: siteA.id },
      workspaceToken,
    );
    expect(del.statusCode).toBe(404);
  });

  it("plant members (VIEW) can read but not author the graph", async () => {
    // FLIP: graph reads for plant VIEW members now succeed as plain member
    // reads; authoring stays MANAGE.
    const list = await rpcCall(server, "graph/node/list", { siteId: siteA.id }, officeToken);
    expect(list.statusCode).toBe(200);
    const create = await rpcCall(server, "graph/node/create", { siteId: siteA.id, name: "office-nope" }, officeToken);
    expect(create.statusCode).toBe(403);
  });
});

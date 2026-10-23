import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const ADMIN = { email: "audit-read-admin@test.local", password: "audit-read-password-1" };
const VIEWER = { email: "audit-read-viewer@test.local", password: "audit-read-password-2" };
const CREW = { email: "audit-read-crew@test.local", password: "audit-read-password-3" };

type Entry = {
  action: string;
  actor: { id: string; name: string | null } | null;
  label: string | null;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  ipAddress?: string | null;
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("reading the audit trail (Tier 2)", () => {
  let server: TestServer;
  let siteId: string;
  let adminId: string;
  let adminToken: string;
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

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    siteId = (await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true } })).id;
    adminId = (await makeUser(ADMIN.email, ADMIN.password, { plants: [{ siteId, level: "ADMIN" }] })).userId;
    await makeUser(VIEWER.email, VIEWER.password, { plants: [{ siteId, level: "VIEW" }] });
    adminToken = await siteToken(ADMIN.email, ADMIN.password);
    viewerToken = await siteToken(VIEWER.email, VIEWER.password);
  });

  afterAll(async () => {
    await server.close();
  });

  it("finds a record's history, pages the plant's activity, and keeps where-from for admins", async () => {
    const sku = `READ-${randomUUID().slice(0, 8)}`;
    const created = await rpcCall(server, "product/create", { siteId, sku, name: "Lid" }, adminToken);
    const { id } = created.json as { id: string };
    await rpcCall(server, "product/update", { id, name: "Lid 2" }, adminToken);
    await rpcCall(server, "product/update", { id, name: "Lid 3" }, adminToken);

    // Anyone who can see the plant sees a record's history, newest first, without IPs.
    const history = await rpcCall(
      server,
      "audit/recordHistory",
      { siteId, entityType: "product", entityId: id },
      viewerToken,
    );
    expect(history.statusCode).toBe(200);
    const entries = (history.json as { entries: Entry[] }).entries;
    expect(entries.map((entry) => entry.action)).toEqual(["RECORD_UPDATED", "RECORD_UPDATED", "RECORD_CREATED"]);
    expect(entries[0]).toMatchObject({
      actor: { id: adminId },
      label: "Lid 3",
      changes: { name: { from: "Lid 2", to: "Lid 3" } },
    });
    expect(entries[0]).not.toHaveProperty("ipAddress");

    // The plant's activity is for its admins.
    expect((await rpcCall(server, "audit/search", { siteId }, viewerToken)).statusCode).toBe(403);

    // Paged with a cursor, filtered by record, and with where-from.
    const first = await rpcCall(
      server,
      "audit/search",
      { siteId, entityType: "product", entityId: id, limit: 2 },
      adminToken,
    );
    const firstPage = first.json as { entries: Entry[]; nextCursor: string | null };
    expect(firstPage.entries).toHaveLength(2);
    expect(firstPage.entries[0]?.ipAddress).toBeTruthy();
    const second = await rpcCall(
      server,
      "audit/search",
      { siteId, entityType: "product", entityId: id, limit: 2, cursor: firstPage.nextCursor },
      adminToken,
    );
    const secondPage = second.json as { entries: Entry[]; nextCursor: string | null };
    expect(secondPage.entries.map((entry) => entry.action)).toEqual(["RECORD_CREATED"]);
    expect(secondPage.nextCursor).toBeNull();

    // By person, and as CSV.
    const actors = (await rpcCall(server, "audit/actors", { siteId }, adminToken)).json as Array<{ id: string }>;
    expect(actors.map((actor) => actor.id)).toContain(adminId);
    const csv = await rpcCall(server, "audit/exportCsv", { siteId, entityType: "product", entityId: id }, adminToken);
    const exported = csv.json as { csv: string; rows: number; truncated: boolean };
    expect(exported.rows).toBe(3);
    expect(exported.csv.split("\n")[0]).toContain("when,action,who");
    expect(exported.csv).toContain("Lid 3");
  });

  it("shows the crew recent changes in their own cells only, moves included", async () => {
    const tag = randomUUID().slice(0, 8);
    const call = async (path: string, input: object) => {
      const result = await rpcCall(server, path, input, adminToken);
      expect(result.statusCode).toBe(200);
      return result.json as { id: string };
    };
    const ours = await call("workcenter/create", { siteId, name: `Ours ${tag}` });
    const theirs = await call("workcenter/create", { siteId, name: `Theirs ${tag}` });
    const press = await call("station/create", { siteId, workcenterId: ours.id, name: `Press ${tag}` });
    const lathe = await call("station/create", { siteId, workcenterId: theirs.id, name: `Lathe ${tag}` });
    await call("station/update", { id: lathe.id, description: "Not ours" });
    const mill = await call("station/create", { siteId, workcenterId: theirs.id, name: `Mill ${tag}` });
    await call("station/move", { id: mill.id, workcenterId: ours.id });

    await makeUser(CREW.email, CREW.password, { workcenters: [{ workcenterId: ours.id, level: "VIEW" }] });
    const crewToken = await siteToken(CREW.email, CREW.password);
    const labels = async (token: string) => {
      const result = await rpcCall(server, "audit/recent", { siteId, limit: 25 }, token);
      expect(result.statusCode).toBe(200);
      const entries = (result.json as { entries: Entry[] }).entries;
      expect(entries.every((entry) => !("ipAddress" in entry))).toBe(true);
      return entries.map((entry) => `${entry.action} ${entry.label}`).filter((label) => label.includes(tag));
    };

    // The crew see their cell, its stations, and the station moved into it, newest first.
    expect(await labels(crewToken)).toEqual([
      `RECORD_UPDATED Mill ${tag}`,
      `RECORD_CREATED Press ${tag}`,
      `RECORD_CREATED Ours ${tag}`,
    ]);
    // The plant's admins see every cell.
    expect(await labels(adminToken)).toHaveLength(7);
  });
});

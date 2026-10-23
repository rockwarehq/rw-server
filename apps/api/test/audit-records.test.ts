import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const ADMIN = { email: "audit-records-admin@test.local", password: "audit-records-password-1" };

describe.skipIf(!process.env.TEST_DATABASE_URL)("record history in the audit trail (Tier 2)", () => {
  let server: TestServer;
  let siteId: string;
  let adminId: string;
  let token: string;

  const call = async (path: string, input: unknown) => {
    const result = await rpcCall(server, path, input, token);
    expect(result.statusCode, JSON.stringify(result.json)).toBe(200);
    return result.json as { id: string } & Record<string, unknown>;
  };
  const entries = (entityType: string, entityId: string) =>
    prisma.auditLog.findMany({ where: { entityType, entityId }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    siteId = (await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true } })).id;
    adminId = (await makeUser(ADMIN.email, ADMIN.password, { plants: [{ siteId, level: "ADMIN" }] })).userId;
    const login = await loginAs(server, ADMIN.email, ADMIN.password);
    const switched = await server.inject({
      method: "POST",
      url: "/auth/switch-site",
      headers: { authorization: `Bearer ${login.accessToken}` },
      payload: { siteId },
    });
    token = (switched.json() as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await server.close();
  });

  it("records a product's life: created, changed field by field, deleted", async () => {
    const sku = `AUD-${randomUUID().slice(0, 8)}`;
    const created = await call("product/create", { siteId, sku, name: "Cap", weight: 4 });
    await call("product/update", { id: created.id, name: "Cap 38mm", weight: 4.5 });
    // Nothing actually changed: no entry.
    await call("product/update", { id: created.id, name: "Cap 38mm" });
    await call("product/delete", { id: created.id });

    const history = await entries("product", created.id);
    expect(history.map((entry) => entry.action)).toEqual(["RECORD_CREATED", "RECORD_UPDATED", "RECORD_DELETED"]);
    for (const entry of history) {
      expect(entry).toMatchObject({ actorId: adminId, siteId, via: "ui" });
      expect(entry.requestId).toBeTruthy();
    }

    const [made, changed] = history;
    expect(made?.metadata).toMatchObject({ label: "Cap" });
    expect(changed?.changes).toEqual({ name: { from: "Cap", to: "Cap 38mm" }, weight: { from: 4, to: 4.5 } });

    // A versioned record: the entry points from the version it replaced to the one it made,
    // and the version says who made it.
    const versions = await prisma.productVersion.findMany({
      where: { productId: created.id },
      orderBy: { version: "asc" },
      select: { id: true, createdById: true },
    });
    // The no-op update still made a version (the service always does); it just isn't a change.
    expect(versions).toHaveLength(3);
    expect(versions.every((version) => version.createdById === adminId)).toBe(true);
    expect(made?.versionId).toBe(versions[0]?.id);
    expect(changed).toMatchObject({ previousVersionId: versions[0]?.id, versionId: versions[1]?.id });
  });

  it("never records an employee's PIN or badge, only that they changed", async () => {
    const created = await call("employee/create", {
      siteId,
      firstName: "Pat",
      lastName: `Audit ${randomUUID().slice(0, 6)}`,
      pin: "4321",
    });
    await call("employee/update", { id: created.id, pin: "8765", badgeNumber: `B-${randomUUID().slice(0, 6)}` });

    const history = await entries("employee", created.id);
    expect(history.map((entry) => entry.action)).toEqual(["RECORD_CREATED", "RECORD_UPDATED"]);
    expect(history[1]?.metadata).toMatchObject({ pinChanged: true, badgeChanged: true });
    const stored = JSON.stringify(history);
    expect(stored).not.toContain("4321");
    expect(stored).not.toContain("8765");
    expect(stored).not.toMatch(/pinHash|badgeNumber/);
  });

  it("records an unversioned record with its before and after values", async () => {
    const created = await call("workcenter/create", { siteId, name: `Cell ${randomUUID().slice(0, 6)}` });
    await call("workcenter/update", { id: created.id, description: "Two presses" });

    const history = await entries("workcenter", created.id);
    expect(history.map((entry) => entry.action)).toEqual(["RECORD_CREATED", "RECORD_UPDATED"]);
    expect(history[1]?.changes).toEqual({ description: { from: null, to: "Two presses" } });
    expect(history[1]?.versionId).toBeNull();
  });
});

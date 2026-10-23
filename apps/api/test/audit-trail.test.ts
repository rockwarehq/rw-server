import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import { logEvent, runWithAuditContext } from "@rw/services/audit/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const ADMIN = { email: "audit-admin@test.local", password: "audit-admin-password-1" };

describe.skipIf(!process.env.TEST_DATABASE_URL)("audit trail (Tier 2)", () => {
  let server: TestServer;
  let siteId: string;
  let adminId: string;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    siteId = (await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true } })).id;
    adminId = (await makeUser(ADMIN.email, ADMIN.password, { plants: [{ siteId, level: "ADMIN" }] })).userId;
  });

  afterAll(async () => {
    await server.close();
  });

  it("fills who, where from and how from the audit context", async () => {
    const entityId = randomUUID();
    await runWithAuditContext(
      {
        ipAddress: "203.0.113.7",
        userAgent: "test-agent/1.0",
        requestId: "req-1",
        actor: { actorId: adminId, siteId, via: "agent:Claude Code" },
      },
      () => logEvent({ action: "API_TOKEN_CREATED", entityType: "test", entityId }),
    );
    const row = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "test", entityId } });
    expect(row).toMatchObject({
      actorId: adminId,
      siteId,
      via: "agent:Claude Code",
      ipAddress: "203.0.113.7",
      userAgent: "test-agent/1.0",
      requestId: "req-1",
    });
  });

  it("lets a call site say who and how, over the context", async () => {
    const entityId = randomUUID();
    const other = randomUUID();
    await runWithAuditContext({ actor: { actorId: adminId, via: "ui" } }, () =>
      logEvent({ action: "API_TOKEN_CREATED", actorId: other, via: "system", entityType: "test", entityId }),
    );
    const row = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "test", entityId } });
    expect(row).toMatchObject({ actorId: other, via: "system" });
  });

  it("writes inside the caller's transaction: rolled back, nothing is recorded", async () => {
    const kept = randomUUID();
    const dropped = randomUUID();
    await prisma.$transaction((tx) => logEvent({ action: "API_TOKEN_CREATED", entityType: "test", entityId: kept, tx }));
    await expect(
      prisma.$transaction(async (tx) => {
        await logEvent({ action: "API_TOKEN_CREATED", entityType: "test", entityId: dropped, tx });
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    expect(await prisma.auditLog.count({ where: { entityType: "test", entityId: kept } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: "test", entityId: dropped } })).toBe(0);
  });

  it("records an RPC action with the caller, plant, IP, user agent and request id", async () => {
    const login = await loginAs(server, ADMIN.email, ADMIN.password);
    const switched = await server.inject({
      method: "POST",
      url: "/auth/switch-site",
      headers: { authorization: `Bearer ${login.accessToken}` },
      payload: { siteId },
    });
    const token = (switched.json() as { accessToken: string }).accessToken;
    const name = `audit-${randomUUID().slice(0, 8)}`;
    const created = await rpcCall(server, "apiToken/create", { name, siteId }, token);
    expect(created.statusCode).toBe(200);

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: "API_TOKEN_CREATED", metadata: { path: ["name"], equals: name } },
    });
    expect(row.actorId).toBe(adminId);
    expect(row.siteId).toBe(siteId);
    expect(row.workspaceId).toBeTruthy();
    expect(row.via).toBe("ui");
    expect(row.ipAddress).toBeTruthy();
    // Unique, not Fastify's per-process counter (req-1, req-2, ...).
    expect(row.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

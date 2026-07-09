import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";

const LIMITED_EMAIL = "limited@test.local";
const LIMITED_PASSWORD = "limited-password-123";

// Tier 2: a workspace member with NO role assignments must be denied on
// permission-guarded routes.
describe.skipIf(!process.env.TEST_DATABASE_URL)("permission enforcement (Tier 2)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: "default" } });
    const passwordHash = await hashPassword(LIMITED_PASSWORD);
    const limited = await prisma.user.upsert({
      where: { email: LIMITED_EMAIL },
      update: {},
      create: { email: LIMITED_EMAIL, passwordHash, firstName: "Limited", status: "ACTIVE" },
    });
    await prisma.workspaceMembership.upsert({
      where: { userId_workspaceId: { userId: limited.id, workspaceId: workspace.id } },
      update: {},
      create: { userId: limited.id, workspaceId: workspace.id },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: LIMITED_EMAIL } });
    await server.close();
  });

  it("denies a role-less member on a permission-guarded route", async () => {
    const tokens = await loginAs(server, LIMITED_EMAIL, LIMITED_PASSWORD);
    const res = await server.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toHaveProperty("error");
  });

  it("still allows the role-less member to read their own profile", async () => {
    const tokens = await loginAs(server, LIMITED_EMAIL, LIMITED_PASSWORD);
    const res = await server.inject({
      method: "GET",
      url: "/users/me",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

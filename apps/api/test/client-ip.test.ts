import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeUser } from "./helpers/access.js";
import { buildServer, type TestServer } from "./helpers/build-server.js";

// Behind fly's edge proxy the socket is the proxy, and the person's address is
// the X-Forwarded-For entry the proxy added (the rightmost). TRUST_PROXY=1
// believes exactly that one hop.

const forwarded = (client: string) => ({
  remoteAddress: "fdaa::1",
  headers: { "x-forwarded-for": `6.6.6.6, ${client}` },
});

describe("the caller's address behind a proxy", () => {
  const ipOf = async (server: TestServer) => {
    server.get("/__test/ip", async (request) => ({ ip: request.ip }));
    await server.ready();
    const response = await server.inject({ method: "GET", url: "/__test/ip", ...forwarded("203.0.113.7") });
    await server.close();
    return (response.json() as { ip: string }).ip;
  };

  it("is the address fly's proxy saw, not one the client wrote", async () => {
    expect(await ipOf(buildServer({ trustProxy: 1 }))).toBe("203.0.113.7");
  });

  it("is the socket's when no proxy is trusted", async () => {
    expect(await ipOf(buildServer())).toBe("fdaa::1");
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("the caller's address behind a proxy (Tier 2)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = buildServer({ trustProxy: 1 });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  const login = (client: string, email: string) =>
    server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "not-the-password" },
      ...forwarded(client),
    });

  it("goes into the audit trail", async () => {
    const email = `client-ip-${randomUUID().slice(0, 8)}@test.local`;
    const { userId } = await makeUser(email, "client-ip-password-1", {});
    await login("203.0.113.21", email);
    const entry = await prisma.auditLog.findFirst({
      where: { action: "LOGIN_FAILED", userId },
      orderBy: { createdAt: "desc" },
    });
    expect(entry?.ipAddress).toBe("203.0.113.21");
  });

  it("limits each person's sign-ins, not everyone behind the proxy together", async () => {
    const email = `nobody-${randomUUID().slice(0, 8)}@test.local`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await login("198.51.100.1", email)).statusCode);
    expect(statuses).toContain(429);
    expect((await login("198.51.100.2", email)).statusCode).not.toBe(429);
  });
});

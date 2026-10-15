import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";

const EMAIL = "mcp-viewer@test.local";
const PASSWORD = "mcp-viewer-password-1";

async function mcp(server: TestServer, token: string | null, method: string, params: unknown = {}) {
  const response = await server.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { statusCode: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
}

// Tier 2: the agent's tools over MCP run as the caller and hide propose tools
// from nobody but API tokens.
describe.skipIf(!process.env.TEST_DATABASE_URL)("MCP endpoint (Tier 2)", () => {
  let server: TestServer;
  let siteToken: string;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    const site = await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true } });
    await makeUser(EMAIL, PASSWORD, { plants: [{ siteId: site.id, level: "VIEW" }] });
    const login = await loginAs(server, EMAIL, PASSWORD);
    const switched = await server.inject({
      method: "POST",
      url: "/auth/switch-site",
      headers: { authorization: `Bearer ${login.accessToken}` },
      payload: { siteId: site.id },
    });
    siteToken = (switched.json() as { accessToken: string }).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: EMAIL } });
    await server.close();
  });

  it("rejects anonymous callers", async () => {
    const res = await mcp(server, null, "tools/list");
    expect(res.statusCode).toBe(401);
  });

  it("lists the agent tools and runs a read tool as the caller", async () => {
    const list = await mcp(server, siteToken, "tools/list");
    expect(list.statusCode).toBe(200);
    const names = (list.body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain("graph_diagnostics");
    expect(names).toContain("propose_changeset");

    const call = await mcp(server, siteToken, "tools/call", { name: "graph_conformance", arguments: {} });
    expect(call.statusCode).toBe(200);
    expect(call.body.result.isError).toBeFalsy();
  });

  it("refuses to propose changesets for a plant member without ADMIN", async () => {
    const call = await mcp(server, siteToken, "tools/call", {
      name: "propose_changeset",
      arguments: { title: "nope", nodes: [{ ref: "n", name: "mcp-nope" }] },
    });
    expect(call.body.result.isError).toBe(true);
  });
});

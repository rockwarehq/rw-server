import { createHash, randomBytes } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadUserCurrent } from "../src/auth/plugin.js";
import { router } from "../src/rpc/index.js";
import { makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

// People connecting their own agents: OAuth 2.1 (DCR + PKCE + rotation) in
// front of /mcp, IMM's consent procedures, the plant opt-in, and the scope
// ceiling on what a connected agent can reach.

const ADMIN = { email: "oauth-admin@test.local", password: "oauth-admin-password-1" };
const MEMBER = { email: "oauth-member@test.local", password: "oauth-member-password-1" };
const VIEWER = { email: "oauth-viewer@test.local", password: "oauth-viewer-password-1" };
const SUPPORT = { email: "oauth-support@test.local", password: "oauth-support-password-1" };
const REDIRECT = "http://127.0.0.1:43123/callback";

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

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
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body ? JSON.parse(response.body) : null,
  };
}

async function token(server: TestServer, params: Record<string, string>) {
  const response = await server.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(params).toString(),
  });
  return { statusCode: response.statusCode, json: response.json() as Record<string, string> };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("agent connections over OAuth (Tier 2)", () => {
  let server: TestServer;
  let siteId: string;
  let adminToken: string;
  let memberToken: string;
  let viewerToken: string;
  let supportToken: string;
  let clientId: string;

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

  /** Authorize → consent (approve as `as`) → the code, ready to exchange. */
  async function authorizeCode(as: string, scopes: string[], challenge: string) {
    const authorize = await server.inject({
      method: "GET",
      url: `/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "xyz",
        scope: scopes.join(" "),
      })}`,
    });
    expect(authorize.statusCode).toBe(302);
    const consent = new URL(authorize.headers.location as string);
    expect(consent.pathname).toBe("/oauth/authorize");
    const request = consent.searchParams.get("request") as string;
    const approved = await rpcCall(server, "agentConnection/approve", { request, siteId, scopes }, as);
    return { approved, request };
  }

  async function connect(as: string, scopes: string[]) {
    const { verifier, challenge } = pkce();
    const { approved } = await authorizeCode(as, scopes, challenge);
    expect(approved.statusCode).toBe(200);
    const redirect = new URL((approved.json as { redirectTo: string }).redirectTo);
    expect(redirect.searchParams.get("state")).toBe("xyz");
    const code = redirect.searchParams.get("code") as string;
    const exchanged = await token(server, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(exchanged.statusCode).toBe(200);
    return { ...exchanged.json, code, verifier };
  }

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    siteId = (await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true } })).id;
    await makeUser(ADMIN.email, ADMIN.password, { plants: [{ siteId, level: "ADMIN" }] });
    await makeUser(MEMBER.email, MEMBER.password, { plants: [{ siteId, level: "MANAGE" }] });
    await makeUser(VIEWER.email, VIEWER.password, { plants: [{ siteId, level: "VIEW" }] });
    const support = await makeUser(SUPPORT.email, SUPPORT.password);
    await prisma.user.update({ where: { id: support.userId }, data: { systemRole: "SUPPORT" } });
    await prisma.site.update({ where: { id: siteId }, data: { agentConnections: false } });
    adminToken = await siteToken(ADMIN.email, ADMIN.password);
    memberToken = await siteToken(MEMBER.email, MEMBER.password);
    viewerToken = await siteToken(VIEWER.email, VIEWER.password);
    supportToken = await siteToken(SUPPORT.email, SUPPORT.password);
  }, 30_000);

  afterAll(async () => {
    await prisma.oAuthClient.deleteMany({ where: { name: { startsWith: "oauth-test" } } });
    await prisma.site.update({ where: { id: siteId }, data: { agentConnections: false } });
    await prisma.user.deleteMany({
      where: { email: { in: [ADMIN.email, MEMBER.email, VIEWER.email, SUPPORT.email] } },
    });
    await server.close();
  });

  it("points an unauthenticated agent at the authorization server", async () => {
    const res = await mcp(server, null, "tools/list");
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/resource_metadata=".*\/\.well-known\/oauth-protected-resource"/);

    const resource = await server.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });
    expect(resource.json()).toMatchObject({ resource: expect.stringMatching(/\/mcp$/) });
    const metadata = await server.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    expect(metadata.json()).toMatchObject({
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      registration_endpoint: expect.stringMatching(/\/oauth\/register$/),
    });
  });

  it("registers public clients with loopback or https redirects only", async () => {
    const bad = await server.inject({
      method: "POST",
      url: "/oauth/register",
      payload: { client_name: "oauth-test bad", redirect_uris: ["http://evil.example/cb"] },
    });
    expect(bad.statusCode).toBe(400);

    const good = await server.inject({
      method: "POST",
      url: "/oauth/register",
      payload: { client_name: "oauth-test agent", redirect_uris: [REDIRECT] },
    });
    expect(good.statusCode).toBe(201);
    clientId = (good.json() as { client_id: string }).client_id;
  });

  it("never redirects to an unregistered URI", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://evil.example/cb",
        code_challenge: "x",
        code_challenge_method: "S256",
      })}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires PKCE S256", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT })}`,
    });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).searchParams.get("error")).toBe("invalid_request");
  });

  it("refuses connections until a plant ADMIN allows them", async () => {
    const { approved } = await authorizeCode(adminToken, ["read"], pkce().challenge);
    expect(approved.statusCode).toBe(403);

    const byMember = await rpcCall(server, "agentConnection/setPolicy", { siteId, enabled: true }, memberToken);
    expect(byMember.statusCode).toBe(403);
    const byAdmin = await rpcCall(server, "agentConnection/setPolicy", { siteId, enabled: true }, adminToken);
    expect(byAdmin.statusCode).toBe(200);
  });

  it("caps what a person can grant at what they can do", async () => {
    const viewer = await authorizeCode(viewerToken, ["read", "setup:propose"], pkce().challenge);
    expect(viewer.approved.statusCode).toBe(403);
    const support = await authorizeCode(supportToken, ["read", "setup:propose"], pkce().challenge);
    expect(support.approved.statusCode).toBe(403);

    const described = await rpcCall(server, "agentConnection/describeRequest", { request: viewer.request }, viewerToken);
    const site = (described.json as { sites: Array<{ id: string; grantableScopes: string[] }> }).sites.find(
      (s) => s.id === siteId,
    );
    expect(site?.grantableScopes).toEqual(["read"]);
  });

  it("connects, serves IMM reads as the person, and keeps the token off /rpc", async () => {
    const tokens = await connect(memberToken, ["read"]);

    const list = await mcp(server, tokens.access_token, "tools/list");
    expect(list.statusCode).toBe(200);
    const names = (list.body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain("imm_products_search");
    expect(names.some((name) => name.startsWith("graph_"))).toBe(false);
    expect(names).not.toContain("propose_changeset");
    expect(names).not.toContain("setup_propose");

    const call = await mcp(server, tokens.access_token, "tools/call", { name: "imm_products_search", arguments: {} });
    expect(call.body.result.isError).toBeFalsy();

    const rpc = await rpcCall(server, "product/list", { siteId }, tokens.access_token);
    expect(rpc.statusCode).toBe(401);
  });

  it("lets a propose grant propose setup over MCP and hands back the review link", async () => {
    const tokens = await connect(memberToken, ["read", "setup:propose"]);
    const list = await mcp(server, tokens.access_token, "tools/list");
    const names = (list.body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["setup_schema", "setup_propose", "setup_replan"]));

    const call = await mcp(server, tokens.access_token, "tools/call", {
      name: "setup_propose",
      arguments: { title: "oauth test", spec: { source: "oauth-test", materials: [{ key: "OAUTH-MAT-1" }] } },
    });
    expect(call.body.result.isError).toBeFalsy();
    const output = JSON.parse(call.body.result.content[0].text) as { id: string; next: string };
    expect(output.next).toContain(`/settings/imports/${output.id}`);
    const row = await prisma.setupChangeset.findUniqueOrThrow({ where: { id: output.id } });
    expect(row.author).toBe("AGENT");
    await prisma.setupChangeset.delete({ where: { id: output.id } });
  });

  it("burns the connection when a code is replayed", async () => {
    const tokens = await connect(memberToken, ["read"]);
    const replay = await token(server, {
      grant_type: "authorization_code",
      code: tokens.code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: tokens.verifier,
    });
    expect(replay.json.error).toBe("invalid_grant");
    expect((await mcp(server, tokens.access_token, "tools/list")).statusCode).toBe(401);
  });

  it("rejects a wrong PKCE verifier", async () => {
    const { challenge } = pkce();
    const { approved } = await authorizeCode(memberToken, ["read"], challenge);
    const code = new URL((approved.json as { redirectTo: string }).redirectTo).searchParams.get("code") as string;
    const res = await token(server, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: pkce().verifier,
    });
    expect(res.json.error).toBe("invalid_grant");
  });

  it("rotates refresh tokens, tolerates a racing reuse, and revokes on late reuse", async () => {
    const first = await connect(memberToken, ["read"]);
    const rotated = await token(server, {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(rotated.statusCode).toBe(200);
    expect((await mcp(server, rotated.json.access_token, "tools/list")).statusCode).toBe(200);

    // Inside the grace window (parallel calls racing a refresh): fine.
    const raced = await token(server, {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(raced.statusCode).toBe(200);

    // After it: theft. The whole connection goes.
    await prisma.oAuthToken.updateMany({
      where: { kind: "REFRESH", rotatedAt: { not: null } },
      data: { rotatedAt: new Date(Date.now() - 5 * 60 * 1000) },
    });
    const stolen = await token(server, {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(stolen.json.error).toBe("invalid_grant");
    expect((await mcp(server, rotated.json.access_token, "tools/list")).statusCode).toBe(401);
  });

  it("stops an agent on revoke, and while the plant has connections off", async () => {
    const tokens = await connect(memberToken, ["read"]);
    const listed = await rpcCall(server, "agentConnection/list", { siteId }, adminToken);
    const all = listed.json as { canManageAll: boolean; data: Array<{ id: string; mine: boolean }> };
    expect(all.canManageAll).toBe(true);
    expect(all.data.length).toBeGreaterThan(0);

    await rpcCall(server, "agentConnection/setPolicy", { siteId, enabled: false }, adminToken);
    expect((await mcp(server, tokens.access_token, "tools/list")).statusCode).toBe(403);
    await rpcCall(server, "agentConnection/setPolicy", { siteId, enabled: true }, adminToken);
    expect((await mcp(server, tokens.access_token, "tools/list")).statusCode).toBe(200);

    const mine = await rpcCall(server, "agentConnection/list", { siteId }, memberToken);
    const grantId = (mine.json as { data: Array<{ id: string }> }).data[0].id;
    expect((await rpcCall(server, "agentConnection/revoke", { id: grantId }, viewerToken)).statusCode).toBe(403);
    expect((await rpcCall(server, "agentConnection/revoke", { id: grantId }, memberToken)).statusCode).toBe(200);
    expect((await mcp(server, tokens.access_token, "tools/list")).statusCode).toBe(401);
  });

  it("closes every procedure not listed for a connected agent's scopes", async () => {
    const person = await prisma.user.findUniqueOrThrow({ where: { email: MEMBER.email }, select: { id: true } });
    const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { workspaceId: true } });
    const current = await loadUserCurrent(person.id, site.workspaceId, siteId);
    if (current?.kind !== "user") throw new Error("expected a user");
    const via = { kind: "oauth" as const, grantId: "g", clientId: "c", clientName: "test", scopes: ["read"] };
    const client = createRouterClient(router, {
      context: { request: { headers: {} }, current: { ...current, via }, access: current.access },
    });

    await expect(client.product.list({ siteId })).resolves.toBeDefined();
    await expect(client.product.create({ siteId, sku: "oauth-nope" } as never)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(client.agentConnection.setPolicy({ siteId, enabled: false })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

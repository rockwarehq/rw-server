import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Agents are behind AGENTS_ENABLED (the rest of the suite runs with it on).
// config.ts reads env at module load, so each case stubs the flag off and
// imports fresh copies of what it checks.
async function freshWithAgentsOff() {
  vi.stubEnv("AGENTS_ENABLED", "false");
  vi.resetModules();
}

describe("agents feature flag (off)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("needs the flag even when a model key is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    await freshWithAgentsOff();
    const { agentConfig } = await import("../src/config.js");
    expect(agentConfig).toMatchObject({ available: false, enabled: false });
  });

  it("leaves the run-agent action out of the automation catalog", async () => {
    await freshWithAgentsOff();
    const { ACTION_SCHEMAS } = await import("../src/automations/actions/index.js");
    expect(Object.keys(ACTION_SCHEMAS)).not.toContain("runAgent");
    expect(Object.keys(ACTION_SCHEMAS)).toContain("notify");
  });

  it("does not serve MCP", async () => {
    await freshWithAgentsOff();
    const { buildServer } = await import("./helpers/build-server.js");
    const server = buildServer();
    await server.ready();
    try {
      const response = await server.inject({ method: "POST", url: "/mcp", payload: {} });
      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});

// Tier 2: a signed-in plant admin sees no agent surface, but status still
// answers so Console can decide to hide it.
describe.skipIf(!process.env.TEST_DATABASE_URL)("agents feature flag (off, Tier 2)", () => {
  const EMAIL = "agent-flag-admin@test.local";
  const PASSWORD = "agent-flag-password-1";
  let server: Awaited<ReturnType<typeof import("./helpers/build-server.js").buildServer>>;
  let rpcCall: typeof import("./helpers/rpc-call.js").rpcCall;
  let token: string;
  let siteId: string;

  beforeAll(async () => {
    await freshWithAgentsOff();
    const { default: prisma } = await import("@rw/db");
    const { makeUser } = await import("./helpers/access.js");
    const helpers = await import("./helpers/build-server.js");
    ({ rpcCall } = await import("./helpers/rpc-call.js"));
    server = helpers.buildServer();
    await server.ready();
    siteId = (await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true } })).id;
    await makeUser(EMAIL, PASSWORD, { plants: [{ siteId, level: "ADMIN" }] });
    token = (await helpers.loginAs(server, EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    const { default: prisma } = await import("@rw/db");
    await prisma.user.deleteMany({ where: { email: EMAIL } });
    await server?.close();
    vi.unstubAllEnvs();
  });

  it("reports agents unavailable", async () => {
    const result = await rpcCall(server, "agent/status", {}, token);
    expect(result.statusCode).toBe(200);
    expect(result.json).toMatchObject({ available: false, enabled: false });
  });

  it.each([
    ["agent/session/list", { siteId: "" }],
    ["agent/definition/list", { siteId: "" }],
    ["agent/approval/list", { siteId: "", status: "PENDING" }],
    ["graph/changeset/list", { siteId: "" }],
  ])("hides %s", async (path, input) => {
    const result = await rpcCall(server, path, { ...input, siteId }, token);
    expect(result.statusCode).toBe(404);
  });
});

import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyPlan, ask, status } from "../src/rpc/insights.js";

// The two AI flags: AI_ENABLED turns Insights on, CONFIG_AGENT_ENABLED adds
// the setup assistant. Each rpc checks them, not just the page.

const mocks = vi.hoisted(() => ({
  aiConfig: {
    enabled: false,
    configAgentEnabled: false,
    insights: undefined as undefined | { provider: "openai"; apiKey: string },
  },
  askInsights: vi.fn(),
  planFor: vi.fn(),
  applyPlan: vi.fn(),
}));
vi.mock("../src/config.js", () => ({ aiConfig: mocks.aiConfig }));
vi.mock("../src/rpc/middleware.js", async () => {
  const { os } = await import("@orpc/server");
  return { userRequired: os };
});
vi.mock("@rw/services/insights/ask", () => ({
  askInsights: mocks.askInsights,
  insightsModel: () => "gpt-5.5",
}));
vi.mock("../src/setup/tools.js", () => ({ setupTools: () => ["setup-tool"], SETUP_INSTRUCTIONS: "setup words" }));
vi.mock("../src/setup/plans.js", () => ({ planFor: mocks.planFor, applyPlan: mocks.applyPlan }));

const SITE = "11111111-1111-4111-8111-111111111111";
const PLAN = "22222222-2222-4222-8222-222222222222";
let userCount = 0;
const context = () =>
  ({ access: { list: () => ({}) }, current: { kind: "user", user: { id: `u${++userCount}` } } }) as never;

function setFlags(ai: boolean, agent: boolean) {
  mocks.aiConfig.enabled = ai;
  mocks.aiConfig.configAgentEnabled = ai && agent;
  mocks.aiConfig.insights = ai ? { provider: "openai", apiKey: "sk-test" } : undefined;
}

async function drain(iterator: AsyncIterable<unknown>) {
  for await (const _ of iterator) {
    // just run it
  }
}

const question = { siteId: SITE, messages: [{ role: "user", content: "How did we do?" }] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.askInsights.mockResolvedValue((async function* () {})());
  setFlags(false, false);
});

describe("AI flags", () => {
  it("status says off when AI_ENABLED is off", async () => {
    expect(await call(status, { siteId: SITE }, { context: context() })).toEqual({
      enabled: false,
      configAgent: false,
    });
  });

  it("status names the model and the setup assistant when they are on", async () => {
    setFlags(true, true);
    expect(await call(status, { siteId: SITE }, { context: context() })).toEqual({
      enabled: true,
      configAgent: true,
      model: "gpt-5.5",
    });
  });

  it("ask is refused when AI_ENABLED is off", async () => {
    await expect(drain(await call(ask, question, { context: context() }))).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(mocks.askInsights).not.toHaveBeenCalled();
  });

  it("ask leaves out the setup tools when CONFIG_AGENT_ENABLED is off", async () => {
    setFlags(true, false);
    await drain(await call(ask, question, { context: context() }));
    const input = mocks.askInsights.mock.calls[0]?.[0];
    expect(input.extraTools).toBeUndefined();
    expect(input.extraInstructions).toBeUndefined();
    expect(input.ai).toEqual({ provider: "openai", apiKey: "sk-test" });
  });

  it("ask offers the setup tools when CONFIG_AGENT_ENABLED is on", async () => {
    setFlags(true, true);
    await drain(await call(ask, question, { context: context() }));
    const input = mocks.askInsights.mock.calls[0]?.[0];
    expect(input.extraTools).toEqual(["setup-tool"]);
    expect(input.extraInstructions).toBe("setup words");
  });

  it("applyPlan is refused when CONFIG_AGENT_ENABLED is off, even with AI on", async () => {
    setFlags(true, false);
    await expect(
      drain(await call(applyPlan, { siteId: SITE, planId: PLAN }, { context: context() })),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mocks.planFor).not.toHaveBeenCalled();
  });
});

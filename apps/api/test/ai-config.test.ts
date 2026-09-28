import { afterEach, describe, expect, it, vi } from "vitest";

// How AI_ENABLED, CONFIG_AGENT_ENABLED and the keys add up to aiConfig.
// config.ts reads the env once when loaded, so each case loads it fresh.

async function load(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  return (await import("../src/config.js")).aiConfig;
}

const NO_AI = {
  AI_ENABLED: undefined,
  CONFIG_AGENT_ENABLED: undefined,
  OPENAI_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
  INSIGHTS_PROVIDER: undefined,
  INSIGHTS_MODEL: undefined,
  INSIGHTS_EFFORT: undefined,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("aiConfig", () => {
  it("is off by default, even with a key", async () => {
    const ai = await load({ ...NO_AI, OPENAI_API_KEY: "sk-test" });
    expect(ai).toEqual({ enabled: false, configAgentEnabled: false, insights: undefined });
  });

  it("stays off with the flag but no key, or an empty key", async () => {
    expect((await load({ ...NO_AI, AI_ENABLED: "true" })).enabled).toBe(false);
    expect((await load({ ...NO_AI, AI_ENABLED: "true", OPENAI_API_KEY: "" })).enabled).toBe(false);
  });

  it("turns on with the flag and a key, and the provider follows the key", async () => {
    const ai = await load({ ...NO_AI, AI_ENABLED: "true", ANTHROPIC_API_KEY: "sk-ant" });
    expect(ai.enabled).toBe(true);
    expect(ai.configAgentEnabled).toBe(false);
    expect(ai.insights).toMatchObject({ provider: "anthropic", apiKey: "sk-ant" });
  });

  it("keeps the setup assistant off unless AI is on too", async () => {
    const withoutAi = await load({ ...NO_AI, CONFIG_AGENT_ENABLED: "true", OPENAI_API_KEY: "sk-test" });
    expect(withoutAi.configAgentEnabled).toBe(false);
    const withAi = await load({ ...NO_AI, AI_ENABLED: "true", CONFIG_AGENT_ENABLED: "true", OPENAI_API_KEY: "sk" });
    expect(withAi.configAgentEnabled).toBe(true);
  });

  it("is off when the chosen provider has no key", async () => {
    const ai = await load({ ...NO_AI, AI_ENABLED: "true", INSIGHTS_PROVIDER: "anthropic", OPENAI_API_KEY: "sk" });
    expect(ai.enabled).toBe(false);
  });
});

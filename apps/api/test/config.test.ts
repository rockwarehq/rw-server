import { afterEach, describe, expect, it, vi } from "vitest";

// config.ts parses process.env at module load — test it by stubbing env and
// re-importing a fresh copy each time.
async function loadConfig() {
  vi.resetModules();
  return import("../src/config.js");
}

const PROD_BASELINE = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://user:pass@db:5432/app",
  REDIS_URL: "redis://redis:6379",
  APP_BASE_URL: "https://demo.rockware.io",
  PROCESSOR_SHARED_SECRET: "a-sufficiently-long-secret",
};

describe("config validation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("production requires DATABASE_URL, REDIS_URL, APP_BASE_URL, PROCESSOR_SHARED_SECRET", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("APP_BASE_URL", "");
    vi.stubEnv("PROCESSOR_SHARED_SECRET", "");
    await expect(loadConfig()).rejects.toThrow(/Invalid environment configuration/);
  });

  it("production accepts a complete environment", async () => {
    for (const [key, value] of Object.entries(PROD_BASELINE)) vi.stubEnv(key, value);
    const config = await loadConfig();
    expect(config.env.isDevelopment).toBe(false);
  });

  it("reflects any origin by default, even in production", async () => {
    for (const [key, value] of Object.entries(PROD_BASELINE)) vi.stubEnv(key, value);
    const config = await loadConfig();
    expect(config.corsConfig.origins).toBe(true);
  });

  it("production rejects a non-https APP_BASE_URL", async () => {
    for (const [key, value] of Object.entries(PROD_BASELINE)) vi.stubEnv(key, value);
    vi.stubEnv("APP_BASE_URL", "http://demo.rockware.io");
    await expect(loadConfig()).rejects.toThrow(/APP_BASE_URL/);
  });

  it("rejects a non-numeric PORT instead of silently defaulting", async () => {
    vi.stubEnv("PORT", "abc");
    await expect(loadConfig()).rejects.toThrow(/PORT/);
  });

  it("CORS_ALLOW_ANY=false uses an exact-match allowlist, additive to APP_BASE_URL", async () => {
    for (const [key, value] of Object.entries(PROD_BASELINE)) vi.stubEnv(key, value);
    vi.stubEnv("CORS_ALLOW_ANY", "false");
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "https://staging.rockware.io, https://ops.rockware.io");
    const config = await loadConfig();
    expect(config.corsConfig.origins).toEqual([
      "https://demo.rockware.io",
      "https://staging.rockware.io",
      "https://ops.rockware.io",
    ]);
  });
});

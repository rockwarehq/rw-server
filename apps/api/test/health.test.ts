import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerReadinessCheck, unregisterReadinessCheck } from "../src/readiness.js";
import { buildServer, type TestServer } from "./helpers/build-server.js";

describe("health & readiness", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("GET /health returns static ok", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /healthz aliases /health", async () => {
    const res = await server.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /ready returns 200 with check report when all critical checks pass", async () => {
    registerReadinessCheck("passing", () => true);
    try {
      const res = await server.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ready");
      expect(body.checks.passing).toMatchObject({ ok: true, critical: true });
      expect(typeof body.checks.passing.latencyMs).toBe("number");
    } finally {
      unregisterReadinessCheck("passing");
    }
  });

  it("GET /ready returns 503 when a critical check fails, with the error surfaced", async () => {
    registerReadinessCheck("failing", () => {
      throw new Error("dependency down");
    });
    try {
      const res = await server.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.status).toBe("not_ready");
      expect(body.checks.failing).toMatchObject({ ok: false, critical: true, error: "dependency down" });
    } finally {
      unregisterReadinessCheck("failing");
    }
  });

  it("GET /ready stays 200 when only a non-critical check fails", async () => {
    registerReadinessCheck("optional", () => false, { critical: false });
    try {
      const res = await server.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(200);
      expect(res.json().checks.optional).toMatchObject({ ok: false, critical: false });
    } finally {
      unregisterReadinessCheck("optional");
    }
  });

  it("GET /readyz aliases /ready", async () => {
    const res = await server.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ready");
  });
});

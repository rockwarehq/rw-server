import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type TestServer } from "./helpers/build-server.js";

describe("security headers & CORS", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("responses carry helmet headers", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["strict-transport-security"]).toContain("max-age=");
  });

  it("401 responses have a consistent { error } shape", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/users/me",
      headers: { authorization: "Bearer garbage-token" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty("error");
  });

  it("dev/test mode reflects any origin (no allowlist configured)", async () => {
    const res = await server.inject({
      method: "OPTIONS",
      url: "/auth/login",
      headers: {
        origin: "https://anything.example",
        "access-control-request-method": "POST",
      },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://anything.example");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});

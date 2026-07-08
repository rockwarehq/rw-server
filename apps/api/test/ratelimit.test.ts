import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type TestServer } from "./helpers/build-server.js";

describe("rate limiting", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("token refresh 429s after 30 requests/min with a retry-after header", async () => {
    let last: Awaited<ReturnType<TestServer["inject"]>> | undefined;
    for (let i = 0; i < 31; i++) {
      last = await server.inject({
        method: "POST",
        url: "/auth/refresh",
        payload: { refreshToken: "not-a-real-token" },
      });
      if (i < 30) expect(last.statusCode).not.toBe(429);
    }
    expect(last?.statusCode).toBe(429);
    expect(last?.headers["retry-after"]).toBeDefined();
    const body = last?.json();
    expect(body).toMatchObject({ statusCode: 429, error: "Too many requests" });
  });

  it("login 429s after 5 requests/min (sensitive tier)", async () => {
    let last: Awaited<ReturnType<TestServer["inject"]>> | undefined;
    for (let i = 0; i < 6; i++) {
      last = await server.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "nobody@example.com", password: "wrong" },
      });
      if (i < 5) expect(last.statusCode).not.toBe(429);
    }
    expect(last?.statusCode).toBe(429);
  });

  it("/health is exempt from rate limiting", async () => {
    for (let i = 0; i < 120; i++) {
      await server.inject({ method: "GET", url: "/health" });
    }
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

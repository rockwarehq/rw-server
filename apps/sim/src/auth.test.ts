import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SimEngine } from "./engine.js";
import { createServer } from "./server.js";

// A fake platform API: one user per access token, a refresh that rotates.
const USERS: Record<string, { id: string; email: string; workspace: string }> = {
  "at-ok": { id: "u1", email: "op@plant.test", workspace: "ws-1" },
  "at-fresh": { id: "u1", email: "op@plant.test", workspace: "ws-1" },
  "at-other": { id: "u2", email: "x@else.test", workspace: "ws-2" },
};

function fakeApi(url: string, init?: RequestInit): Response {
  const path = new URL(url).pathname;
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
  if (path === "/auth/login") {
    if (body.password !== "right") return json(401, { error: "Invalid credentials" });
    return json(200, { accessToken: body.email === "x@else.test" ? "at-other" : "at-ok", refreshToken: "rt-1" });
  }
  if (path === "/auth/refresh") {
    return body.refreshToken === "rt-1" ? json(200, { accessToken: "at-fresh", refreshToken: "rt-2" }) : json(401, {});
  }
  if (path === "/users/me") {
    const token = String((init?.headers as Record<string, string>)?.authorization ?? "").replace("Bearer ", "");
    const u = USERS[token];
    return u ? json(200, { user: { id: u.id, email: u.email }, workspace: { id: u.workspace } }) : json(401, {});
  }
  return json(404, {});
}

const engine = {
  workspaceIds: () => new Set(["ws-1"]),
  views: () => [],
  station: () => undefined,
} as unknown as SimEngine;

const cookiesFrom = (setCookie: string | string[] | undefined) =>
  (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []).map((c) => c.split(";")[0]).join("; ");

describe("sign-in", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => fakeApi(url, init)));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("rejects /api without a session", async () => {
    const res = await createServer(engine, { apiUrl: "http://api.test" }).inject({ url: "/api/stations" });
    expect(res.statusCode).toBe(401);
  });

  it("signs in and then serves /api with the session cookies", async () => {
    const server = createServer(engine, { apiUrl: "http://api.test" });
    const login = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "op@plant.test", password: "right" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.email).toBe("op@plant.test");
    const setCookie = login.headers["set-cookie"];
    expect(String(setCookie)).toContain("HttpOnly");

    const res = await server.inject({ url: "/api/stations", headers: { cookie: cookiesFrom(setCookie) } });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a wrong password", async () => {
    const res = await createServer(engine, { apiUrl: "http://api.test" }).inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "op@plant.test", password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects users from a workspace that doesn't own the stations", async () => {
    const res = await createServer(engine, { apiUrl: "http://api.test" }).inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "x@else.test", password: "right" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("refreshes an expired access token from the refresh cookie", async () => {
    const res = await createServer(engine, { apiUrl: "http://api.test" }).inject({
      url: "/api/session",
      headers: { cookie: "sim_at=at-expired; sim_rt=rt-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe("op@plant.test");
    expect(String(res.headers["set-cookie"])).toContain("sim_rt=rt-2");
  });
});

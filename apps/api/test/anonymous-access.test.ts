import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type TestServer } from "./helpers/build-server.js";

/**
 * Regression net for the anonymous-route class of defect: every REST route
 * must carry the verifyAccessToken preHandler unless it is deliberately
 * public. Runs Tier 1 — route registration needs no database.
 *
 * Two layers:
 * 1. Structural: walk the route table (onRoute hook) and assert the guard is
 *    present or the route is allowlisted below.
 * 2. Behavioral: anonymous GETs (no body to trip schema validation first)
 *    must answer 401.
 */

/** Deliberately tokenless routes. Every entry needs a reason. */
const PUBLIC_REST_ROUTES = new Set(
  [
    // liveness/readiness probes
    "GET /health",
    "GET /healthz",
    "GET /ready",
    "GET /readyz",
    // credential exchange — no session exists yet
    "POST /auth/login",
    "POST /auth/logout",
    "POST /auth/refresh",
    "POST /auth/display/login",
    "POST /auth/display/refresh",
    "POST /auth/display/logout",
    // reset code flows — user cannot authenticate yet
    "POST /users/password/forgot",
    "POST /users/password/verify",
    "POST /users/password/reset",
    // gateway bootstrap: exchanges serial + claim code for a token
    "POST /edge/claim",
    // gateway-token principal, validated in-handler (not IAM)
    "POST /edge/connect",
    "POST /edge/sync",
    "POST /edge/disconnect",
  ].map((s) => s.toUpperCase()),
);

/** Prefixes handled by their own auth stacks. */
const EXEMPT_PREFIXES = ["/rpc/", "/docs"];

interface CollectedRoute {
  method: string;
  url: string;
  hasAccessTokenGuard: boolean;
}

describe("anonymous access", () => {
  let server: TestServer;
  const routes: CollectedRoute[] = [];

  beforeAll(async () => {
    server = buildServer();
    server.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      const preHandlers = Array.isArray(route.preHandler) ? route.preHandler : route.preHandler ? [route.preHandler] : [];
      // Identity check against the decorator; requirePermission routes carry
      // verifyAccessToken alongside, so one predicate covers both mechanisms.
      const hasAccessTokenGuard = preHandlers.some((fn) => fn === server.verifyAccessToken);
      for (const method of methods) {
        if (method === "HEAD" || method === "OPTIONS") continue;
        routes.push({ method, url: route.url, hasAccessTokenGuard });
      }
    });
    await server.ready();
  }, 30_000);

  afterAll(async () => {
    await server.close();
  });

  const isExempt = (url: string) => EXEMPT_PREFIXES.some((p) => url === p.replace(/\/$/, "") || url.startsWith(p));
  const key = (r: CollectedRoute) => `${r.method} ${r.url}`.toUpperCase();

  it("collected a plausible route table", () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it("every REST route is token-guarded or explicitly public", () => {
    const unguarded = routes
      .filter((r) => !isExempt(r.url))
      .filter((r) => !PUBLIC_REST_ROUTES.has(key(r)))
      .filter((r) => !r.hasAccessTokenGuard)
      .map(key);
    expect(unguarded).toEqual([]);
  });

  it("the public allowlist contains no stale entries", () => {
    const known = new Set(routes.map(key));
    const stale = [...PUBLIC_REST_ROUTES].filter((entry) => !known.has(entry));
    expect(stale).toEqual([]);
  });

  it("anonymous GET requests are rejected with 401", async () => {
    const gets = routes.filter(
      (r) => r.method === "GET" && !isExempt(r.url) && !PUBLIC_REST_ROUTES.has(key(r)),
    );
    expect(gets.length).toBeGreaterThan(10);
    for (const route of gets) {
      const url = route.url.replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000000");
      const res = await server.inject({ method: "GET", url });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });
});

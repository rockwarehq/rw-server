import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { router } from "../src/rpc/index.js";
import {
  EXCLUDED_PROCEDURES,
  PUBLIC_REST_ROUTES,
  SELF_SERVICE_REST_ROUTES,
} from "../src/rpc/policy-coverage.js";
import { buildServer, type TestServer } from "./helpers/build-server.js";

/**
 * Authorization coverage gate (ADR-0002 amendment). Fails CI when a
 * procedure or route ships without a policy check and without an explicit,
 * commented exclusion. Tier 1 — no database required.
 */

// Bundlers/vitest rewrite imported calls as (0,__import__.authorize)(...),
// so match the identifier rather than an exact call shape.
const POLICY_CALL = /\bauthorize(List|AccessibleSites)?\b/;

interface Leaf {
  path: string;
  handlerSource: string;
}

function collectLeaves(node: unknown, path: string[], out: Leaf[]): void {
  if (!node || typeof node !== "object") return;
  if ("~orpc" in node) {
    const orpc = (node as { "~orpc": { handler?: unknown } })["~orpc"];
    // Fail loudly if oRPC internals move — silently skipping would turn the
    // gate off without anyone noticing.
    if (typeof orpc.handler !== "function") {
      throw new Error(`oRPC internals changed: no handler on ${path.join(".")}`);
    }
    out.push({ path: path.join("."), handlerSource: orpc.handler.toString() });
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    collectLeaves(value, [...path, key], out);
  }
}

describe("authorization coverage", () => {
  const leaves: Leaf[] = [];
  collectLeaves(router, [], leaves);

  it("collected a plausible procedure count", () => {
    expect(leaves.length).toBeGreaterThan(250);
  });

  it("every RPC procedure calls the policy inline or is explicitly excluded", () => {
    const unguarded = leaves
      .filter((leaf) => !EXCLUDED_PROCEDURES.has(leaf.path))
      .filter((leaf) => !POLICY_CALL.test(leaf.handlerSource))
      .map((leaf) => leaf.path);
    expect(unguarded).toEqual([]);
  });

  it("the exclusion list contains no stale entries", () => {
    const known = new Set(leaves.map((leaf) => leaf.path));
    const stale = [...EXCLUDED_PROCEDURES].filter((path) => !known.has(path));
    expect(stale).toEqual([]);
  });
});

describe("REST authorization coverage", () => {
  let server: TestServer;
  interface CollectedRoute {
    method: string;
    url: string;
    hasAccessTokenGuard: boolean;
    hasPermissionGuard: boolean;
  }
  const routes: CollectedRoute[] = [];

  beforeAll(async () => {
    server = buildServer();
    server.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      const preHandlers = Array.isArray(route.preHandler) ? route.preHandler : route.preHandler ? [route.preHandler] : [];
      const hasAccessTokenGuard = preHandlers.some((fn) => fn === server.verifyAccessToken);
      const handlerSource = typeof route.handler === "function" ? route.handler.toString() : "";
      // requirePermission preHandlers are anonymous closures over hasPermission;
      // policy-based handlers contain authorize()/replyPolicyDenial() calls.
      const hasPermissionGuard =
        preHandlers.some((fn) => /hasPermission|requirePermission/.test(fn.toString())) ||
        POLICY_CALL.test(handlerSource) ||
        /\breplyPolicyDenial\b/.test(handlerSource) ||
        /\bhasPermission\b/.test(handlerSource);
      for (const method of methods) {
        if (method === "HEAD" || method === "OPTIONS") continue;
        routes.push({ method, url: route.url, hasAccessTokenGuard, hasPermissionGuard });
      }
    });
    await server.ready();
  }, 30_000);

  afterAll(async () => {
    await server.close();
  });

  const normalize = (url: string) => (url.length > 1 ? url.replace(/\/+$/, "") : url);
  const key = (r: { method: string; url: string }) => `${r.method} ${normalize(r.url)}`.toUpperCase();
  const isExempt = (url: string) => url === "/docs" || url.startsWith("/docs/") || url.startsWith("/rpc/");

  it("every REST route has a permission mechanism or an explicit exemption", () => {
    const unguarded = routes
      .filter((r) => !isExempt(r.url))
      .filter((r) => !PUBLIC_REST_ROUTES.has(key(r)))
      .filter((r) => !SELF_SERVICE_REST_ROUTES.has(key(r)))
      .filter((r) => !(r.hasAccessTokenGuard && r.hasPermissionGuard))
      .map(key);
    expect(unguarded).toEqual([]);
  });

  it("the REST allowlists contain no stale entries", () => {
    const known = new Set(routes.map(key));
    const stale = [...PUBLIC_REST_ROUTES, ...SELF_SERVICE_REST_ROUTES]
      .map((entry) => {
        const [method, url] = entry.split(" ");
        return `${method} ${normalize(url)}`;
      })
      .filter((entry) => !known.has(entry));
    expect(stale).toEqual([]);
  });
});

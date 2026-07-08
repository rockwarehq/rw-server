import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@rw/db";
import { createAccessToken } from "@rw/auth/verify";
import { API_TOKEN_PREFIX } from "@rw/auth/api-tokens";

import type { LivestoreLogger } from "../types/index.js";
import { LivestoreAuthenticator, bearerFromAuthorizationHeader } from "./auth.js";

const logger: LivestoreLogger = { info: () => {}, warn: () => {}, error: () => {} };

const APP_TOKEN = `${API_TOKEN_PREFIX}${"a".repeat(64)}`;

// Prisma stub for the api-token path: one mutable row, call-counted lookups.
function makeDbStub() {
  const state = {
    findUniqueCalls: 0,
    row: {
      id: "tok-1",
      name: "t",
      workspaceId: "ws-1",
      siteId: "site-1",
      scopes: ["graph:read"],
      revokedAt: null as Date | null,
      expiresAt: null as Date | null,
      lastUsedAt: null as Date | null,
    } as Record<string, unknown> | null,
  };
  const db = {
    apiToken: {
      findUnique: async () => {
        state.findUniqueCalls += 1;
        return state.row;
      },
      updateMany: async () => ({ count: 1 }),
    },
  };
  return { db: db as unknown as PrismaClient, state };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LivestoreAuthenticator JWTs", () => {
  it("accepts a user token with workspace+site context", async () => {
    const { db } = makeDbStub();
    const auth = new LivestoreAuthenticator(db, logger);
    const token = createAccessToken({ id: "u1", email: "a@b.c", workspaceId: "ws-1", siteId: "site-1" });

    const principal = await auth.authenticate(token);
    expect(principal).toMatchObject({ kind: "user", userId: "u1", workspaceId: "ws-1", siteId: "site-1" });
    expect(principal?.expMs).toBeGreaterThan(Date.now());
  });

  it("rejects a user token without a siteId", async () => {
    const { db } = makeDbStub();
    const auth = new LivestoreAuthenticator(db, logger);
    const token = createAccessToken({ id: "u1", email: "a@b.c", workspaceId: "ws-1" });
    expect(await auth.authenticate(token)).toBeNull();
  });

  it("accepts a display token", async () => {
    const { db } = makeDbStub();
    const auth = new LivestoreAuthenticator(db, logger);
    const token = createAccessToken({ principal: "DISPLAY", displayId: "d1", siteId: "site-1", workspaceId: "ws-1" });
    expect(await auth.authenticate(token)).toMatchObject({ kind: "display", displayId: "d1", siteId: "site-1" });
  });

  it("rejects garbage tokens", async () => {
    const { db } = makeDbStub();
    const auth = new LivestoreAuthenticator(db, logger);
    expect(await auth.authenticate("not-a-jwt")).toBeNull();
  });
});

describe("LivestoreAuthenticator api-token cache", () => {
  it("serves repeat validations from cache within the positive TTL", async () => {
    vi.useFakeTimers();
    const { db, state } = makeDbStub();
    const auth = new LivestoreAuthenticator(db, logger);

    expect(await auth.authenticate(APP_TOKEN)).toMatchObject({ kind: "app", apiTokenId: "tok-1" });
    expect(await auth.authenticate(APP_TOKEN)).toMatchObject({ kind: "app" });
    expect(state.findUniqueCalls).toBe(1);
  });

  it("sees a revocation once the positive TTL lapses", async () => {
    vi.useFakeTimers();
    const { db, state } = makeDbStub();
    const auth = new LivestoreAuthenticator(db, logger);

    expect(await auth.authenticate(APP_TOKEN)).not.toBeNull();
    state.row = { ...(state.row as Record<string, unknown>), revokedAt: new Date() };

    // Still cached inside the TTL...
    vi.advanceTimersByTime(29_000);
    expect(await auth.authenticate(APP_TOKEN)).not.toBeNull();

    // ...revoked once it lapses.
    vi.advanceTimersByTime(2_000);
    expect(await auth.authenticate(APP_TOKEN)).toBeNull();
  });

  it("caches negative results briefly", async () => {
    vi.useFakeTimers();
    const { db, state } = makeDbStub();
    state.row = null;
    const auth = new LivestoreAuthenticator(db, logger);

    expect(await auth.authenticate(APP_TOKEN)).toBeNull();
    expect(await auth.authenticate(APP_TOKEN)).toBeNull();
    expect(state.findUniqueCalls).toBe(1);

    vi.advanceTimersByTime(11_000);
    expect(await auth.authenticate(APP_TOKEN)).toBeNull();
    expect(state.findUniqueCalls).toBe(2);
  });

  it("revalidateApiToken reflects the current token state", async () => {
    vi.useFakeTimers();
    const { db, state } = makeDbStub();
    const auth = new LivestoreAuthenticator(db, logger);

    expect(await auth.revalidateApiToken(APP_TOKEN)).toBe(true);
    state.row = null;
    vi.advanceTimersByTime(31_000);
    expect(await auth.revalidateApiToken(APP_TOKEN)).toBe(false);
  });
});

describe("bearerFromAuthorizationHeader", () => {
  it("extracts bearer values and rejects everything else", () => {
    expect(bearerFromAuthorizationHeader("Bearer abc")).toBe("abc");
    expect(bearerFromAuthorizationHeader("Basic abc")).toBeNull();
    expect(bearerFromAuthorizationHeader(undefined)).toBeNull();
    expect(bearerFromAuthorizationHeader(["Bearer abc"])).toBeNull();
  });
});

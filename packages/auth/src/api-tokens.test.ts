import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@rw/db";

import { API_TOKEN_PREFIX, createApiToken, touchApiToken, validateApiToken } from "./api-tokens.js";
import { hashToken } from "./secrets.js";

// The service takes an injectable Prisma client; these tests exercise the pure
// token logic (format, hashing, revoked/expired gating, throttle window)
// against an in-memory stub — no database.

interface StoredToken {
  id: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  scopes: string[];
  workspaceId: string;
  siteId: string;
  createdById: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

function makeDbStub(initial: StoredToken[] = []) {
  const rows = [...initial];
  const updateManyCalls: unknown[] = [];
  const db = {
    site: {
      findFirst: async ({ where }: { where: { id: string; workspaceId: string } }) =>
        where.id === "site-1" && where.workspaceId === "ws-1" ? { id: where.id } : null,
    },
    apiToken: {
      create: async ({ data }: { data: Omit<StoredToken, "id" | "createdAt" | "revokedAt" | "lastUsedAt"> }) => {
        const row: StoredToken = {
          id: `tok-${rows.length + 1}`,
          createdAt: new Date(),
          revokedAt: null,
          lastUsedAt: null,
          ...data,
        };
        rows.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        rows.find((r) => r.tokenHash === where.tokenHash) ?? null,
      updateMany: async (args: unknown) => {
        updateManyCalls.push(args);
        return { count: 1 };
      },
    },
  };
  return { db: db as unknown as PrismaClient, rows, updateManyCalls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createApiToken", () => {
  it("issues an rw_app_ token, stores only its hash, and derives the display prefix", async () => {
    const { db, rows } = makeDbStub();
    const result = await createApiToken({ name: "acme", workspaceId: "ws-1", siteId: "site-1" }, db);

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.token).toMatch(new RegExp(`^${API_TOKEN_PREFIX}[0-9a-f]{64}$`));
    expect(result.tokenPrefix).toBe(result.token.slice(0, API_TOKEN_PREFIX.length + 8));
    expect(rows[0]?.tokenHash).toBe(hashToken(result.token));
    expect(rows[0]?.scopes).toEqual(["graph:read"]);
    // Plaintext never persisted.
    expect(JSON.stringify(rows)).not.toContain(result.token);
  });

  it("rejects a site outside the workspace", async () => {
    const { db } = makeDbStub();
    const result = await createApiToken({ name: "x", workspaceId: "ws-1", siteId: "other-site" }, db);
    expect(result).toEqual({ error: "SITE_NOT_IN_WORKSPACE" });
  });
});

describe("validateApiToken", () => {
  async function issue(db: PrismaClient) {
    const created = await createApiToken({ name: "t", workspaceId: "ws-1", siteId: "site-1" }, db);
    if ("error" in created) throw new Error("unexpected");
    return created;
  }

  it("returns identity and scoping for a live token", async () => {
    const { db } = makeDbStub();
    const created = await issue(db);
    const validated = await validateApiToken(created.token, db);
    expect(validated).toMatchObject({ id: created.id, workspaceId: "ws-1", siteId: "site-1", scopes: ["graph:read"] });
  });

  it("returns null without a DB hit for non-rw_app_ tokens", async () => {
    const { db } = makeDbStub();
    const apiToken = (db as unknown as { apiToken: { findUnique: (...args: unknown[]) => unknown } }).apiToken;
    const findUnique = vi.spyOn(apiToken, "findUnique");
    expect(await validateApiToken("eyJhbGciOi...", db)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns null for unknown, revoked, and expired tokens alike", async () => {
    const { db, rows } = makeDbStub();
    const created = await issue(db);

    expect(await validateApiToken(`${API_TOKEN_PREFIX}${"0".repeat(64)}`, db)).toBeNull();

    rows[0]!.revokedAt = new Date();
    expect(await validateApiToken(created.token, db)).toBeNull();

    rows[0]!.revokedAt = null;
    rows[0]!.expiresAt = new Date(Date.now() - 1000);
    expect(await validateApiToken(created.token, db)).toBeNull();
  });
});

describe("touchApiToken", () => {
  it("uses a conditional update bounded by the 5-minute throttle window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T12:00:00Z"));

    const { db, updateManyCalls } = makeDbStub();
    await touchApiToken("tok-1", db);

    expect(updateManyCalls).toHaveLength(1);
    const call = updateManyCalls[0] as {
      where: { id: string; OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: Date } }] };
      data: { lastUsedAt: Date };
    };
    expect(call.where.id).toBe("tok-1");
    expect(call.where.OR[1].lastUsedAt.lt.getTime()).toBe(new Date("2026-07-08T11:55:00Z").getTime());
    expect(call.data.lastUsedAt.getTime()).toBe(new Date("2026-07-08T12:00:00Z").getTime());
  });
});

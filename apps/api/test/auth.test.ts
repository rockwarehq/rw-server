import prisma from "@rw/db";
import { createDisplayRefreshToken, hashToken, REFRESH_REUSE_GRACE_MS } from "@rw/auth/tokens";
import { refreshDisplaySession } from "@rw/auth/display-session";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./global-setup.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";

// Tier 2: needs a migrated + seeded Postgres (TEST_DATABASE_URL).
describe.skipIf(!process.env.TEST_DATABASE_URL)("auth flows (Tier 2)", () => {
  let server: TestServer;
  // The sensitive-endpoint rate limit is 5/min/IP (securityConfig) and every
  // login in this file hits it from 127.0.0.1 — budget logins accordingly.
  // Access tokens are stateless JWTs, so later tests can reuse this session
  // even after refresh-token-family revocations.
  let adminTokens: { accessToken: string; refreshToken: string };

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("login succeeds with seeded admin credentials", async () => {
    adminTokens = await loginAs(server, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    expect(adminTokens.accessToken).toBeTruthy();
    expect(adminTokens.refreshToken).toBeTruthy();
  });

  it("login fails with wrong password and a { error } body", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: TEST_ADMIN_EMAIL, password: "definitely-wrong" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty("error");
  });

  it("refresh rotates the token; re-presenting it within the grace window still refreshes", async () => {
    const tokens = await loginAs(server, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);

    const first = await server.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const rotated = first.json() as { refreshToken: string };
    expect(rotated.refreshToken).toBeTruthy();
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);

    // Benign re-presentation (lost rotation response, concurrent tab): the
    // just-rotated token refreshes again instead of tripping theft detection.
    const reuse = await server.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(reuse.statusCode).toBe(200);
    const graced = reuse.json() as { refreshToken: string };
    expect(graced.refreshToken).not.toBe(tokens.refreshToken);

    // The family is intact: the first rotation's token still refreshes.
    const rotatedRefresh = await server.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: rotated.refreshToken },
    });
    expect(rotatedRefresh.statusCode).toBe(200);
  });

  it("reuse after the grace window revokes the entire token family", async () => {
    const tokens = await loginAs(server, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);

    const first = await server.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const rotated = first.json() as { refreshToken: string };

    // Age the rotation past the grace window.
    await prisma.refreshToken.update({
      where: { tokenHash: hashToken(tokens.refreshToken) },
      data: { rotatedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 5_000) },
    });

    const reuse = await server.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);

    // Theft response nukes the family: the otherwise-valid rotated token is dead.
    const rotatedRefresh = await server.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: rotated.refreshToken },
    });
    expect(rotatedRefresh.statusCode).toBe(401);
  });

  it("a token revoked by logout gets no grace", async () => {
    const tokens = await loginAs(server, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);

    const logout = await server.inject({
      method: "POST",
      url: "/auth/logout",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(logout.statusCode).toBe(200);

    // Security revocation (no rotatedAt): immediate reuse must still 401.
    const reuse = await server.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it("display refresh honors the same reuse grace window", async () => {
    const site = await prisma.site.findFirstOrThrow();
    const display = await prisma.display.create({
      data: { name: "auth-test-display", status: "CLAIMED", siteId: site.id },
    });
    try {
      const { token } = await createDisplayRefreshToken(display.id);

      const first = await refreshDisplaySession(token);
      expect(first.success).toBe(true);

      // Within grace: benign re-presentation refreshes.
      const reuse = await refreshDisplaySession(token);
      expect(reuse.success).toBe(true);

      // Past grace: theft — family revoked, everything dies.
      await prisma.displayRefreshToken.update({
        where: { tokenHash: hashToken(token) },
        data: { rotatedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 5_000) },
      });
      const late = await refreshDisplaySession(token);
      expect(late.success).toBe(false);
      if (first.success) {
        const rotatedRefresh = await refreshDisplaySession(first.data.refreshToken);
        expect(rotatedRefresh.success).toBe(false);
      }
    } finally {
      await prisma.display.delete({ where: { id: display.id } });
    }
  });

  it("GET /users/me roundtrips with a valid access token", async () => {
    // Reuses the first test's access token (login budget — see adminTokens).
    const res = await server.inject({
      method: "GET",
      url: "/users/me",
      headers: { authorization: `Bearer ${adminTokens.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { email: TEST_ADMIN_EMAIL } });
  });
});

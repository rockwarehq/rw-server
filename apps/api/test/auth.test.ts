import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./global-setup.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";

// Tier 2: needs a migrated + seeded Postgres (TEST_DATABASE_URL).
describe.skipIf(!process.env.TEST_DATABASE_URL)("auth flows (Tier 2)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("login succeeds with seeded admin credentials", async () => {
    const tokens = await loginAs(server, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
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

  it("refresh rotates the token and rejects reuse of the old one", async () => {
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

    // The pre-rotation token must now be dead.
    const reuse = await server.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it("GET /users/me roundtrips with a valid access token", async () => {
    const tokens = await loginAs(server, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    const res = await server.inject({
      method: "GET",
      url: "/users/me",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { email: TEST_ADMIN_EMAIL } });
  });
});

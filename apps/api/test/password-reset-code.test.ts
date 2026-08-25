import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { hashToken } from "@rw/auth/secrets";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type TestServer } from "./helpers/build-server.js";

const RESET_EMAIL = "reset-code@test.local";
const ORIGINAL_PASSWORD = "OriginalPass123!";
const NEW_PASSWORD = "BrandNewPass456!";

// Every sensitive route is limited to 5 req/min/IP, so each request that
// could collide uses a fresh source address.
let ipTail = 1;
function nextIp(): string {
  return `10.99.0.${ipTail++}`;
}

async function plantCode(email: string, code: string, opts?: { expiry?: Date; attempts?: number }) {
  await prisma.user.update({
    where: { email },
    data: {
      resetTokenHash: hashToken(code),
      resetTokenExpiry: opts?.expiry ?? new Date(Date.now() + 15 * 60 * 1000),
      resetAttempts: opts?.attempts ?? 0,
    },
  });
}

// Tier 2: needs a migrated + seeded Postgres (TEST_DATABASE_URL).
describe.skipIf(!process.env.TEST_DATABASE_URL)("password reset codes (Tier 2)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: "default" } });
    const passwordHash = await hashPassword(ORIGINAL_PASSWORD);
    const user = await prisma.user.upsert({
      where: { email: RESET_EMAIL },
      update: { passwordHash, status: "ACTIVE" },
      create: { email: RESET_EMAIL, passwordHash, status: "ACTIVE" },
    });
    // Login requires a workspace membership
    await prisma.workspaceMembership.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
      update: {},
      create: { userId: user.id, workspaceId: workspace.id },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: RESET_EMAIL } });
    await server.close();
  });

  it("forgot stores a hashed code and returns the generic message", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/users/password/forgot",
      payload: { email: RESET_EMAIL },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      message: "If an account exists with this email, a password reset code has been sent.",
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { email: RESET_EMAIL } });
    expect(user.resetTokenHash).toBeTruthy();
    expect(user.resetTokenExpiry).toBeTruthy();
    expect(user.resetAttempts).toBe(0);
  });

  it("forgot with an unknown email returns the identical response", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/users/password/forgot",
      payload: { email: "nobody@test.local" },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      message: "If an account exists with this email, a password reset code has been sent.",
    });
  });

  it("verify accepts the correct code without burning an attempt", async () => {
    await plantCode(RESET_EMAIL, "483920");

    const res = await server.inject({
      method: "POST",
      url: "/users/password/verify",
      payload: { email: RESET_EMAIL, code: "483920" },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true });

    const user = await prisma.user.findUniqueOrThrow({ where: { email: RESET_EMAIL } });
    expect(user.resetAttempts).toBe(0);
  });

  it("verify rejects a wrong code and increments the attempt counter", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/users/password/verify",
      payload: { email: RESET_EMAIL, code: "000000" },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false });

    const user = await prisma.user.findUniqueOrThrow({ where: { email: RESET_EMAIL } });
    expect(user.resetAttempts).toBe(1);
  });

  it("verify with an unknown email is indistinguishable from a wrong code", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/users/password/verify",
      payload: { email: "nobody@test.local", code: "483920" },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false });
  });

  it("reset with a formatted code sets the password, clears state, and revokes sessions", async () => {
    const login = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: RESET_EMAIL, password: ORIGINAL_PASSWORD },
      remoteAddress: nextIp(),
    });
    expect(login.statusCode).toBe(200);
    const oldTokens = login.json() as { refreshToken: string };

    await plantCode(RESET_EMAIL, "112233");
    // The reset must also clear an admin-issued must-change flag
    await prisma.user.update({ where: { email: RESET_EMAIL }, data: { mustChangePassword: true } });

    const res = await server.inject({
      method: "POST",
      url: "/users/password/reset",
      payload: { email: RESET_EMAIL, code: "11 22-33", password: NEW_PASSWORD },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const user = await prisma.user.findUniqueOrThrow({ where: { email: RESET_EMAIL } });
    expect(user.resetTokenHash).toBeNull();
    expect(user.resetTokenExpiry).toBeNull();
    expect(user.resetAttempts).toBe(0);
    expect(user.mustChangePassword).toBe(false);

    // Old session is dead
    const refresh = await server.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: oldTokens.refreshToken },
      remoteAddress: nextIp(),
    });
    expect(refresh.statusCode).toBe(401);

    // New password works
    const newLogin = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: RESET_EMAIL, password: NEW_PASSWORD },
      remoteAddress: nextIp(),
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it("five wrong attempts invalidate the code even when the correct one follows", async () => {
    await plantCode(RESET_EMAIL, "445566");

    for (let i = 0; i < 5; i++) {
      const res = await server.inject({
        method: "POST",
        url: "/users/password/verify",
        payload: { email: RESET_EMAIL, code: "999999" },
        remoteAddress: nextIp(),
      });
      expect(res.json()).toEqual({ valid: false });
    }

    const verify = await server.inject({
      method: "POST",
      url: "/users/password/verify",
      payload: { email: RESET_EMAIL, code: "445566" },
      remoteAddress: nextIp(),
    });
    expect(verify.json()).toEqual({ valid: false });

    const reset = await server.inject({
      method: "POST",
      url: "/users/password/reset",
      payload: { email: RESET_EMAIL, code: "445566", password: "AnotherPass789!" },
      remoteAddress: nextIp(),
    });
    expect(reset.statusCode).toBe(400);
    expect(reset.json()).toMatchObject({ error: "Invalid or expired code" });
  });

  it("an expired code fails with the generic error", async () => {
    await plantCode(RESET_EMAIL, "778899", { expiry: new Date(Date.now() - 1000) });

    const res = await server.inject({
      method: "POST",
      url: "/users/password/reset",
      payload: { email: RESET_EMAIL, code: "778899", password: "AnotherPass789!" },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "Invalid or expired code" });
  });

  it("a weak password is rejected with details before any code is burned", async () => {
    await plantCode(RESET_EMAIL, "224466");

    const res = await server.inject({
      method: "POST",
      url: "/users/password/reset",
      payload: { email: RESET_EMAIL, code: "224466", password: "alllowercasepassword" },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; details: string[] };
    expect(body.details.length).toBeGreaterThan(0);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: RESET_EMAIL } });
    expect(user.resetAttempts).toBe(0);
  });

  it("a successful reset clears a login lockout", async () => {
    await plantCode(RESET_EMAIL, "336699");
    await prisma.user.update({
      where: { email: RESET_EMAIL },
      data: { failedLoginAttempts: 5, lockedUntil: new Date(Date.now() + 15 * 60 * 1000) },
    });

    const res = await server.inject({
      method: "POST",
      url: "/users/password/reset",
      payload: { email: RESET_EMAIL, code: "336699", password: NEW_PASSWORD },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: RESET_EMAIL } });
    expect(user.failedLoginAttempts).toBe(0);
    expect(user.lockedUntil).toBeNull();
  });
});

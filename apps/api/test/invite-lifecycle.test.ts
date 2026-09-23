import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { hashToken } from "@rw/auth/secrets";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePasswordStrength } from "../src/services/validation.js";
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./global-setup.js";
import { makeUser, plantBucketId } from "./helpers/access.js";
import { buildServer, type TestServer } from "./helpers/build-server.js";

const INVITER_EMAIL = "inviter@test.local";
const INVITER_PASSWORD = "InviterPass123!";
const NOPERM_EMAIL = "noperm@test.local";
const NOPERM_PASSWORD = "NopermPass123!";
const ENGINEER_EMAIL = "invite-staff-engineer@test.local";
const ENGINEER_PASSWORD = "StaffEngineer123!";
const INVITEE_EMAILS = [
  "invitee1@test.local",
  "invitee2@test.local",
  "invitee3@test.local",
  "invitee4@test.local",
  "invitee5@test.local",
  "orphan@test.local",
  "disabled-invite@test.local",
  "grandfathered@test.local",
  "owner-invite@test.local",
  "ws2-pending@test.local",
  "ws3-owner@test.local",
  "active-member@test.local",
];

let ipTail = 1;
function nextIp(): string {
  return `10.96.0.${ipTail++}`;
}

async function login(server: TestServer, email: string, password: string) {
  const res = await server.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password },
    remoteAddress: nextIp(),
  });
  return res;
}

// Tier 2: needs a migrated + seeded Postgres (TEST_DATABASE_URL).
describe.skipIf(!process.env.TEST_DATABASE_URL)("invite lifecycle (Tier 2)", () => {
  let server: TestServer;
  let workspaceId: string;
  let siteId: string;
  let plantBucket: string;
  let adminToken: string;
  let inviterToken: string;
  let nopermToken: string;

  // A read-only bucket access at the default plant — the common invite grant.
  const viewAccess = () => [{ bucketId: plantBucket, level: "VIEW" }];

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const workspace = await prisma.workspace.findFirstOrThrow();
    workspaceId = workspace.id;
    const site = await prisma.site.findFirstOrThrow({ where: { workspaceId, name: "Rockware" } });
    siteId = site.id;
    plantBucket = await plantBucketId(siteId);

    // Inviter: plant ADMIN at the site — invite authority is ADMIN at each
    // invited bucket's site plant. Noperm: plain member, no accesses.
    await makeUser(INVITER_EMAIL, INVITER_PASSWORD, {
      plants: [{ siteId, level: "ADMIN" }],
    });
    await makeUser(NOPERM_EMAIL, NOPERM_PASSWORD);

    adminToken = (await login(server, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)).json<{ accessToken: string }>()
      .accessToken;
    inviterToken = (await login(server, INVITER_EMAIL, INVITER_PASSWORD)).json<{ accessToken: string }>().accessToken;
    nopermToken = (await login(server, NOPERM_EMAIL, NOPERM_PASSWORD)).json<{ accessToken: string }>().accessToken;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { in: [INVITER_EMAIL, NOPERM_EMAIL, ENGINEER_EMAIL, ...INVITEE_EMAILS] } },
    });
    await server.close();
  });

  async function invite(token: string, payload: Record<string, unknown>) {
    return server.inject({
      method: "POST",
      url: "/users/invite",
      headers: { authorization: `Bearer ${token}` },
      payload,
      remoteAddress: nextIp(),
    });
  }

  async function revoke(token: string, id: string) {
    return server.inject({
      method: "DELETE",
      url: `/users/invite/${id}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: nextIp(),
    });
  }

  let invitee1Temp: string;

  it("invite creates a pending user and returns the temp password once", async () => {
    // Plant ADMIN so the invitee can pass the admin-gated roster later.
    const res = await invite(adminToken, {
      email: INVITEE_EMAILS[0],
      bucketAccesses: [{ bucketId: plantBucket, level: "ADMIN" }],
      firstName: "Ada",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      user: { id: string; status: string; firstName: string | null };
      temporaryPassword: string;
      expiresAt: string;
      emailSent: boolean;
    };
    expect(body.user.status).toBe("PENDING");
    expect(body.user.firstName).toBe("Ada");
    expect(body.temporaryPassword).toBeTruthy();
    expect(validatePasswordStrength(body.temporaryPassword).valid).toBe(true);
    expect(body.emailSent).toBe(true); // disabled-email path reports success
    invitee1Temp = body.temporaryPassword;

    const row = await prisma.user.findUniqueOrThrow({ where: { email: INVITEE_EMAILS[0] } });
    expect(row.status).toBe("PENDING");
    expect(row.passwordHash).toBeTruthy();
    expect(row.mustChangePassword).toBe(true);
    expect(row.inviteTokenExpiry).toBeTruthy();

    const accesses = await prisma.bucketAccess.findMany({ where: { userId: row.id } });
    expect(accesses).toHaveLength(1);
    expect(accesses[0]?.level).toBe("ADMIN");

    const audit = await prisma.auditLog.findFirst({
      where: { action: "USER_INVITED", userId: row.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit?.metadata)).not.toContain(body.temporaryPassword);
  });

  it("invitee logs in, is boxed in by the gate, and activates by changing the password", async () => {
    const loginRes = await login(server, INVITEE_EMAILS[0], invitee1Temp);
    expect(loginRes.statusCode).toBe(200);
    const tokens = loginRes.json() as { accessToken: string; user: { mustChangePassword: boolean } };
    expect(tokens.user.mustChangePassword).toBe(true);

    const blocked = await server.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: "password_change_required" });

    const change = await server.inject({
      method: "PUT",
      url: "/users/me/password",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { currentPassword: invitee1Temp, newPassword: "MyOwnPassword123!" },
      remoteAddress: nextIp(),
    });
    expect(change.statusCode).toBe(200);

    const row = await prisma.user.findUniqueOrThrow({ where: { email: INVITEE_EMAILS[0] } });
    expect(row.status).toBe("ACTIVE");
    expect(row.mustChangePassword).toBe(false);
    expect(row.inviteTokenExpiry).toBeNull();

    const inviteCompleted = await prisma.auditLog.findFirst({
      where: { action: "INVITE_COMPLETED", userId: row.id },
    });
    expect(inviteCompleted).toBeTruthy();

    // Same token, previously blocked route now passes (invitee is plant ADMIN)
    const unblocked = await server.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(unblocked.statusCode).toBe(200);

    expect((await login(server, INVITEE_EMAILS[0], invitee1Temp)).statusCode).toBe(401);
    expect((await login(server, INVITEE_EMAILS[0], "MyOwnPassword123!")).statusCode).toBe(200);
  });

  it("resend rotates the temporary password and expiry without needing accesses", async () => {
    const first = await invite(adminToken, { email: INVITEE_EMAILS[1], bucketAccesses: viewAccess() });
    expect(first.statusCode).toBe(201);
    const t1 = (first.json() as { temporaryPassword: string }).temporaryPassword;

    const resend = await invite(adminToken, { email: INVITEE_EMAILS[1] });
    expect(resend.statusCode).toBe(201);
    const t2 = (resend.json() as { temporaryPassword: string }).temporaryPassword;
    expect(t2).not.toBe(t1);

    expect((await login(server, INVITEE_EMAILS[1], t1)).statusCode).toBe(401);
    expect((await login(server, INVITEE_EMAILS[1], t2)).statusCode).toBe(200);
  });

  it("expired invites refuse the correct password but stay generic for wrong ones", async () => {
    const res = await invite(adminToken, { email: INVITEE_EMAILS[2], bucketAccesses: viewAccess() });
    const temp = (res.json() as { temporaryPassword: string }).temporaryPassword;

    await prisma.user.update({
      where: { email: INVITEE_EMAILS[2] },
      data: { inviteTokenExpiry: new Date(Date.now() - 1000) },
    });

    const expired = await login(server, INVITEE_EMAILS[2], temp);
    expect(expired.statusCode).toBe(401);
    expect((expired.json() as { error: string }).error).toContain("Invite has expired");

    const wrong = await login(server, INVITEE_EMAILS[2], "WrongPassword123!");
    expect((wrong.json() as { error: string }).error).toBe("Invalid email or password");
  });

  it("revoke deletes the pending user, audits it, and frees the email", async () => {
    const target = await prisma.user.findUniqueOrThrow({ where: { email: INVITEE_EMAILS[2] } });

    const res = await revoke(adminToken, target.id);
    expect(res.statusCode).toBe(200);

    expect(await prisma.user.findUnique({ where: { id: target.id } })).toBeNull();
    expect(await prisma.bucketAccess.count({ where: { userId: target.id } })).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "INVITE_REVOKED", userId: target.id },
    });
    expect(audit?.metadata).toMatchObject({ email: INVITEE_EMAILS[2] });

    // Email is immediately re-invitable
    const reinvite = await invite(adminToken, { email: INVITEE_EMAILS[2], bucketAccesses: viewAccess() });
    expect(reinvite.statusCode).toBe(201);
  });

  it("revoke guards: active users 409, unknown ids 404", async () => {
    const active = await prisma.user.findUniqueOrThrow({ where: { email: INVITEE_EMAILS[0] } });
    expect((await revoke(adminToken, active.id)).statusCode).toBe(409);

    expect((await revoke(adminToken, "00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
  });

  it("orphaned pending users can be adopted by a fresh invite", async () => {
    // Simulate the old bug: PENDING user with no access at all
    await prisma.user.create({
      data: { email: INVITEE_EMAILS[5], status: "PENDING" },
    });

    const noAccess = await invite(adminToken, { email: INVITEE_EMAILS[5] });
    expect(noAccess.statusCode).toBe(400);
    expect((noAccess.json() as { error: string }).error).toBe("bucketAccesses or asAccountAdmin is required");

    const adopted = await invite(adminToken, { email: INVITEE_EMAILS[5], bucketAccesses: viewAccess() });
    expect(adopted.statusCode).toBe(201);

    const row = await prisma.user.findUniqueOrThrow({ where: { email: INVITEE_EMAILS[5] } });
    expect(await prisma.bucketAccess.count({ where: { userId: row.id } })).toBe(1);
    expect(row.passwordHash).toBeTruthy();
  });

  it("removed (disabled) people come back through a fresh invite", async () => {
    await prisma.user.create({
      data: { email: INVITEE_EMAILS[6], status: "DISABLED", passwordHash: await hashPassword("Whatever123!") },
    });
    const noAccess = await invite(adminToken, { email: INVITEE_EMAILS[6] });
    expect(noAccess.statusCode).toBe(400);

    const back = await invite(adminToken, { email: INVITEE_EMAILS[6], bucketAccesses: viewAccess() });
    expect(back.statusCode).toBe(201);
    const row = await prisma.user.findUniqueOrThrow({ where: { email: INVITEE_EMAILS[6] } });
    expect(row.status).toBe("PENDING");
    expect(row.mustChangePassword).toBe(true);
    expect(await prisma.bucketAccess.count({ where: { userId: row.id } })).toBe(1);
  });

  it("permission matrix: no plant ADMIN means no invite/revoke; account-admin invites need an account admin", async () => {
    expect((await invite(nopermToken, { email: "nope@test.local", bucketAccesses: viewAccess() })).statusCode).toBe(
      403,
    );

    const pending = await prisma.user.findUniqueOrThrow({ where: { email: INVITEE_EMAILS[1] } });
    expect((await revoke(nopermToken, pending.id)).statusCode).toBe(403);

    // Plant ADMIN invites at its plant, but cannot make account admins
    const adminByInviter = await invite(inviterToken, { email: INVITEE_EMAILS[8], asAccountAdmin: true });
    expect(adminByInviter.statusCode).toBe(403);

    const adminByAdmin = await invite(adminToken, { email: INVITEE_EMAILS[8], asAccountAdmin: true });
    expect(adminByAdmin.statusCode).toBe(201);
    const invited = await prisma.user.findUniqueOrThrow({ where: { email: INVITEE_EMAILS[8] } });
    expect(invited.isAccountAdmin).toBe(true);

    // ...and revoking an account-admin invite also needs an account admin
    const ownerInvite = await prisma.user.findUniqueOrThrow({ where: { email: INVITEE_EMAILS[8] } });
    expect((await revoke(inviterToken, ownerInvite.id)).statusCode).toBe(403);
    expect((await revoke(adminToken, ownerInvite.id)).statusCode).toBe(200);
  });

  it("pending invitees can activate through the reset-code flow", async () => {
    const res = await invite(adminToken, { email: INVITEE_EMAILS[3], bucketAccesses: viewAccess() });
    expect(res.statusCode).toBe(201);

    const forgot = await server.inject({
      method: "POST",
      url: "/users/password/forgot",
      payload: { email: INVITEE_EMAILS[3] },
      remoteAddress: nextIp(),
    });
    expect(forgot.statusCode).toBe(200);
    let row = await prisma.user.findUniqueOrThrow({ where: { email: INVITEE_EMAILS[3] } });
    expect(row.resetTokenHash).toBeTruthy(); // PENDING-with-password may reset

    await prisma.user.update({
      where: { email: INVITEE_EMAILS[3] },
      data: { resetTokenHash: hashToken("998877"), resetTokenExpiry: new Date(Date.now() + 15 * 60 * 1000) },
    });

    const reset = await server.inject({
      method: "POST",
      url: "/users/password/reset",
      payload: { email: INVITEE_EMAILS[3], code: "998877", password: "ResetChosen123!" },
      remoteAddress: nextIp(),
    });
    expect(reset.statusCode).toBe(200);

    row = await prisma.user.findUniqueOrThrow({ where: { email: INVITEE_EMAILS[3] } });
    expect(row.status).toBe("ACTIVE");
    expect(row.mustChangePassword).toBe(false);
    expect((await login(server, INVITEE_EMAILS[3], "ResetChosen123!")).statusCode).toBe(200);
  });

  it("grandfathered pending users without a password stay locked out", async () => {
    await prisma.user.create({ data: { email: INVITEE_EMAILS[7], status: "PENDING" } });

    const forgot = await server.inject({
      method: "POST",
      url: "/users/password/forgot",
      payload: { email: INVITEE_EMAILS[7] },
      remoteAddress: nextIp(),
    });
    expect(forgot.statusCode).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { email: INVITEE_EMAILS[7] } });
    expect(row.resetTokenHash).toBeNull();

    const loginRes = await login(server, INVITEE_EMAILS[7], "AnythingAtAll123!");
    expect((loginRes.json() as { error: string }).error).toBe("Please complete your registration first");
  });

  it("removing a member disables them and drops their access; the user row survives", async () => {
    const res = await invite(adminToken, { email: INVITEE_EMAILS[4], bucketAccesses: viewAccess() });
    expect(res.statusCode).toBe(201);
    const pending = await prisma.user.findUniqueOrThrow({ where: { email: INVITEE_EMAILS[4] } });

    const removePending = await server.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/members/${pending.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(removePending.statusCode).toBe(200);
    const removed = await prisma.user.findUniqueOrThrow({ where: { id: pending.id } });
    expect(removed.status).toBe("DISABLED");
    expect(await prisma.bucketAccess.count({ where: { userId: pending.id } })).toBe(0);

    const active = await makeUser(INVITEE_EMAILS[11], "ActiveMember123!", { plants: [{ siteId, level: "VIEW" }] });
    const removeActive = await server.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/members/${active.userId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(removeActive.statusCode).toBe(200);
    expect(await prisma.bucketAccess.count({ where: { userId: active.userId } })).toBe(0);
    expect(((await login(server, INVITEE_EMAILS[11], "ActiveMember123!")).json() as { error: string }).error).toBe(
      "Account is disabled",
    );
  });

  it("the last account admin cannot be removed or demoted", async () => {
    const target = await makeUser(INVITEE_EMAILS[10], "LastAdmin123!", { accountAdmin: true });
    // Files run one at a time, so the other admins can step aside briefly.
    const others = await prisma.user.findMany({
      where: { isAccountAdmin: true, id: { not: target.userId } },
      select: { id: true },
    });
    await prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { isAccountAdmin: false } });
    try {
      // ENGINEER staff pass the account-admin gate without being an admin.
      await prisma.user.upsert({
        where: { email: ENGINEER_EMAIL },
        update: { systemRole: "ENGINEER", passwordHash: await hashPassword(ENGINEER_PASSWORD), status: "ACTIVE" },
        create: {
          email: ENGINEER_EMAIL,
          passwordHash: await hashPassword(ENGINEER_PASSWORD),
          systemRole: "ENGINEER",
          status: "ACTIVE",
        },
      });
      const engineerToken = ((await login(server, ENGINEER_EMAIL, ENGINEER_PASSWORD)).json() as { accessToken: string })
        .accessToken;

      const remove = await server.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/members/${target.userId}`,
        headers: { authorization: `Bearer ${engineerToken}` },
      });
      expect(remove.statusCode).toBe(400);
      expect((remove.json() as { error: string }).error).toBe("Cannot remove the last account admin");

      const targetToken = ((await login(server, INVITEE_EMAILS[10], "LastAdmin123!")).json() as { accessToken: string })
        .accessToken;
      const demote = await server.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/members/${target.userId}`,
        headers: { authorization: `Bearer ${targetToken}` },
        payload: { isAccountAdmin: false },
      });
      expect(demote.statusCode).toBe(400);
      expect((demote.json() as { error: string }).error).toBe("Cannot remove the last account admin");
    } finally {
      await prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { isAccountAdmin: true } });
    }
  });
});

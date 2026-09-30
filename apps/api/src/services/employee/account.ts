import prisma, { type Prisma } from "@rw/db";
import type { Level as BucketLevel } from "@rw/auth/iam/access";
import { create } from "./crud.js";

// Every account in a plant is also on its team: the person who logs in is a
// team member (Employee) with a team role at each plant they can reach. The
// link is User.employeeId, which the call, production-mode and shift-note
// services already resolve a signed-in user through (resolveEmployee), so
// what an account does is attributed to that person like any operator.
//
// syncAccountTeamMember is idempotent and runs inside the transaction that
// changed the account's access (invites and member access changes). It only
// ever adds or reactivates; removals are explicit (deactivateSites).

/** The default team role for an access level, by the seeded role names. */
export const LEVEL_ROLE_NAME: Record<BucketLevel, string> = {
  ADMIN: "Manager",
  MANAGE: "Supervisor",
  VIEW: "Operator",
};

const LEVEL_RANK: Record<BucketLevel, number> = { VIEW: 0, MANAGE: 1, ADMIN: 2 };

type Tx = Prisma.TransactionClient;

export interface SyncAccountTeamMemberOptions {
  /** A team role picked for a site (e.g. at invite); wins over the level default. */
  roleIdBySite?: Record<string, string>;
  /** Sites the account just lost; their team access goes inactive unless still reachable. */
  deactivateSites?: string[];
}

/** The email's local part, "pat.lee" → "pat.lee", as a last-resort name. */
function nameFromEmail(email: string): string {
  return email.split("@")[0] || email;
}

/** Each site the account reaches, at the highest level it holds there. */
async function reachableSites(
  tx: Tx,
  user: { isAccountAdmin: boolean; bucketAccesses: Array<{ level: string; bucket: { siteId: string | null } }> },
): Promise<Map<string, BucketLevel>> {
  const sites = new Map<string, BucketLevel>();
  const raise = (siteId: string, level: BucketLevel) => {
    const had = sites.get(siteId);
    if (!had || LEVEL_RANK[level] > LEVEL_RANK[had]) sites.set(siteId, level);
  };
  for (const access of user.bucketAccesses) {
    if (access.bucket.siteId) raise(access.bucket.siteId, access.level as BucketLevel);
  }
  // Account admins administer every plant without holding its bucket.
  if (user.isAccountAdmin) {
    for (const site of await tx.site.findMany({ select: { id: true } })) raise(site.id, "ADMIN");
  }
  return sites;
}

async function defaultRoleId(tx: Tx, siteId: string, level: BucketLevel): Promise<string | null> {
  const roles = await tx.employeeRole.findMany({
    where: { siteId, name: { in: [LEVEL_ROLE_NAME[level], "Operator"] } },
    select: { id: true, name: true },
  });
  return (
    roles.find((role) => role.name === LEVEL_ROLE_NAME[level])?.id ??
    roles.find((role) => role.name === "Operator")?.id ??
    null
  );
}

export async function syncAccountTeamMember(tx: Tx, userId: string, options: SyncAccountTeamMemberOptions = {}) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      systemRole: true,
      isAccountAdmin: true,
      employeeId: true,
      bucketAccesses: { select: { level: true, bucket: { select: { siteId: true } } } },
    },
  });
  // Rockware staff are not on a plant's team.
  if (!user || user.systemRole) return null;

  const sites = await reachableSites(tx, user);

  let employeeId = user.employeeId;
  if (!employeeId && sites.size > 0) {
    // Someone already on the floor team who now gets a login: the one
    // unlinked, active team member with this email is them.
    const sameEmail = await tx.employee.findMany({
      where: {
        status: "ACTIVE",
        user: { is: null },
        version: { is: { email: { equals: user.email, mode: "insensitive" } } },
      },
      select: { id: true },
      take: 2,
    });
    if (sameEmail.length === 1) {
      employeeId = sameEmail[0]!.id;
      await tx.user.update({ where: { id: user.id }, data: { employeeId } });
    }
  }
  if (!employeeId && sites.size > 0) {
    const workspace = await tx.workspace.findFirst({ select: { id: true } });
    if (!workspace) return null;
    const created = await create(
      {
        workspaceId: workspace.id,
        firstName: user.firstName?.trim() || nameFromEmail(user.email),
        lastName: user.lastName?.trim() || "",
        email: user.email,
      },
      tx,
    );
    employeeId = created.data.id;
    await tx.user.update({ where: { id: user.id }, data: { employeeId } });
  }
  if (!employeeId) return null;

  if (sites.size > 0) {
    await tx.employee.update({ where: { id: employeeId }, data: { status: "ACTIVE" } });
  }

  for (const [siteId, level] of sites) {
    const picked = options.roleIdBySite?.[siteId];
    const existing = await tx.employeeSiteAccess.findUnique({
      where: { employeeId_siteId: { employeeId, siteId } },
      select: { id: true, status: true },
    });
    if (existing) {
      // An existing role is the plant's decision; only an explicit pick changes it.
      if (existing.status !== "ACTIVE" || picked) {
        await tx.employeeSiteAccess.update({
          where: { id: existing.id },
          data: { status: "ACTIVE", ...(picked ? { roleId: picked } : {}) },
        });
      }
      continue;
    }
    const roleId = picked ?? (await defaultRoleId(tx, siteId, level));
    // A plant without team roles can't place anyone; access still works.
    if (!roleId) continue;
    await tx.employeeSiteAccess.create({
      data: { employeeId, siteId, roleId, status: "ACTIVE" },
    });
  }

  const lost = (options.deactivateSites ?? []).filter((siteId) => !sites.has(siteId));
  if (lost.length) {
    await tx.employeeSiteAccess.updateMany({
      where: { employeeId, siteId: { in: lost } },
      data: { status: "INACTIVE" },
    });
  }

  return employeeId;
}

/**
 * Checks a team role picked for an account: it must exist and belong to one
 * of the sites being granted. Returns the role's site, or an error.
 */
export async function checkPickedRole(
  roleId: string,
  siteIds: Array<string | null>,
): Promise<{ ok: true; siteId: string } | { ok: false; error: string }> {
  const role = await prisma.employeeRole.findUnique({ where: { id: roleId }, select: { siteId: true } });
  if (!role) return { ok: false, error: "Team role not found" };
  if (!siteIds.includes(role.siteId)) return { ok: false, error: "Team role belongs to another plant" };
  return { ok: true, siteId: role.siteId };
}

/**
 * The profile an invite made, and nothing else ever used: no number, badge
 * or PIN, and no floor history. Revoking the invite deletes it; anything
 * more is a real team member and stays.
 */
export async function isAccountOnlyProfile(tx: Tx, employeeId: string): Promise<boolean> {
  const employee = await tx.employee.findUnique({
    where: { id: employeeId },
    select: {
      version: { select: { employeeNumber: true, badgeNumber: true, pinHash: true } },
      _count: {
        select: {
          openedCalls: true,
          closedCalls: true,
          startedModeLogs: true,
          endedModeLogs: true,
          shiftComments: true,
          logonSessions: true,
          notificationGroups: true,
          notificationDeliveries: true,
        },
      },
    },
  });
  if (!employee) return false;
  const { version, _count } = employee;
  if (version?.employeeNumber || version?.badgeNumber || version?.pinHash) return false;
  return Object.values(_count).every((count) => count === 0);
}

// Access — who may do what, asked of the current request.
//
// Like Basecamp's `Current.person`: the auth plugin builds one Access per
// request and handlers ask it. A "no" throws AccessDenied, which each
// transport maps to its wire error once.
//
// Users are checked against buckets:
//   PLANT (one per site)      VIEW = read the common plant things.
//                             MANAGE = write the plant and everything in it.
//                             ADMIN = people, access, dangerous settings.
//   WORKCENTER (one per cell) VIEW = watch the floor. MANAGE = operate and
//                             configure the cell.
// A Person holds only the rows they were given. Two rules are worked out
// at check time:
//   - Any access at a site makes you a plant member (plant VIEW).
//   - Plant MANAGE or ADMIN means MANAGE on every workcenter at that site.
// Owners and Rockware staff skip the buckets (the bypass below).
//
// Displays and API tokens stay simple: they are bound to one site. A
// display may do anything at its site that its procedures allow; an API
// token may only read.

import prisma from "@rw/db";
import { locateRow, NOT_FOUND_MESSAGES, rowRefParts, type RowRef, type SitelessRowKind } from "./rows.js";

export type Tier = "VIEW" | "MANAGE" | "ADMIN";

export const TIER_RANK: Record<Tier, number> = { VIEW: 1, MANAGE: 2, ADMIN: 3 };

export function tierAtLeast(held: Tier | null | undefined, required: Tier): boolean {
  return held != null && TIER_RANK[held] >= TIER_RANK[required];
}

function higher(a: Tier | null, b: Tier | null): Tier | null {
  if (!a) return b;
  if (!b) return a;
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

// ── Errors ───────────────────────────────────────────────────────────────

export type AccessDeniedCode = "UNAUTHENTICATED" | "NO_WORKSPACE" | "NOT_FOUND" | "FORBIDDEN";

/** Thrown by every Access check. Transports map `code` to their wire error. */
export class AccessDenied extends Error {
  readonly code: AccessDeniedCode;
  constructor(code: AccessDeniedCode, message: string) {
    super(message);
    this.name = "AccessDenied";
    this.code = code;
  }
}

const deny = (code: AccessDeniedCode, message: string) => new AccessDenied(code, message);

// ── The person ───────────────────────────────────────────────────────────

/** A user's standing in one workspace: the rows they were given, nothing derived. */
export interface Person {
  /** Workspace owner: skips buckets, holds ownership-only actions. */
  owner: boolean;
  /** Rockware staff: SUPPORT reads everywhere, ENGINEER manages everywhere. */
  staff: "SUPPORT" | "ENGINEER" | null;
  /** siteId → tier on that site's PLANT bucket. */
  plants: Map<string, Tier>;
  /** workcenterId → tier on that cell's bucket, with the cell's site. */
  workcenters: Map<string, { siteId: string; tier: Tier }>;
}

export function emptyPerson(overrides: Partial<Person> = {}): Person {
  return { owner: false, staff: null, plants: new Map(), workcenters: new Map(), ...overrides };
}

/** Prisma select for the membership rows a Person is built from. */
export function personSelect(workspaceId: string) {
  return {
    systemRole: true,
    memberships: {
      where: { workspaceId },
      select: {
        workspaceRole: true,
        bucketAccesses: {
          select: { tier: true, bucket: { select: { kind: true, siteId: true, workcenterId: true } } },
        },
      },
    },
  } as const;
}

type PersonRows = {
  systemRole: "SUPPORT" | "ENGINEER" | null;
  memberships: Array<{
    workspaceRole: "OWNER" | "MEMBER";
    bucketAccesses: Array<{
      tier: Tier;
      bucket: { kind: "PLANT" | "WORKCENTER"; siteId: string | null; workcenterId: string | null };
    }>;
  }>;
};

/** Turn a user row loaded with {@link personSelect} into a Person. Null without a membership (staff need none). */
export function toPerson(user: PersonRows): Person | null {
  if (user.systemRole) return emptyPerson({ staff: user.systemRole });
  const membership = user.memberships[0];
  if (!membership) return null;
  if (membership.workspaceRole === "OWNER") return emptyPerson({ owner: true });
  return personFromRows(
    membership.bucketAccesses.map((a) => ({
      tier: a.tier,
      kind: a.bucket.kind,
      siteId: a.bucket.siteId,
      workcenterId: a.bucket.workcenterId,
    })),
  );
}

/**
 * Load a user's person in a workspace. Null when the user is missing or has
 * no membership (staff need none). One query.
 */
export async function loadPerson(userId: string, workspaceId: string): Promise<Person | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: personSelect(workspaceId) });
  return user ? toPerson(user) : null;
}

/** Build a person from BucketAccess rows (kept separate for tests). */
export function personFromRows(
  rows: Array<{ tier: Tier; kind: "PLANT" | "WORKCENTER"; siteId: string | null; workcenterId: string | null }>,
): Person {
  const person = emptyPerson();
  for (const row of rows) {
    if (!row.siteId) continue;
    if (row.kind === "PLANT") {
      person.plants.set(row.siteId, higher(person.plants.get(row.siteId) ?? null, row.tier) as Tier);
    } else if (row.workcenterId) {
      const held = person.workcenters.get(row.workcenterId)?.tier ?? null;
      person.workcenters.set(row.workcenterId, { siteId: row.siteId, tier: higher(held, row.tier) as Tier });
    }
  }
  return person;
}

/** The tier held on a site's plant bucket, membership rule included. */
export function plantTier(person: Person, siteId: string): Tier | null {
  const direct = person.plants.get(siteId) ?? null;
  if (direct) return direct;
  for (const wc of person.workcenters.values()) {
    if (wc.siteId === siteId) return "VIEW";
  }
  return null;
}

/** The tier held on one workcenter, plant cascade included. */
export function workcenterTier(person: Person, workcenterId: string, siteId: string): Tier | null {
  const direct = person.workcenters.get(workcenterId);
  const own = direct && direct.siteId === siteId ? direct.tier : null;
  const cascade = tierAtLeast(person.plants.get(siteId), "MANAGE") ? "MANAGE" : null;
  return higher(own, cascade);
}

/** Sites where the person holds anything, or "all" for owners and staff. */
export function visibleSites(person: Person): "all" | string[] {
  if (person.owner || person.staff) return "all";
  const ids = new Set(person.plants.keys());
  for (const wc of person.workcenters.values()) ids.add(wc.siteId);
  return [...ids];
}

/** The one place owners and staff skip the buckets. */
function bypasses(person: Person, tier: Tier): boolean {
  return person.owner || person.staff === "ENGINEER" || (person.staff === "SUPPORT" && tier === "VIEW");
}

// ── The Access interface ─────────────────────────────────────────────────

/** Something a check can be about: a site, or a row located by `{ kind: id }`. */
export type Target = { site: string } | RowRef;

/** Where a checked target lives: always a site, except for site-less row kinds. */
export type Located<T extends Target> = {
  siteId: Extract<keyof T, SitelessRowKind> extends never ? string : string | null;
};

/**
 * One site to list in. `workcenterIds` is set when the caller only holds
 * some cells there: floor rows must belong to those cells (or to no cell).
 */
export interface ListScope {
  siteId: string;
  workcenterIds?: string[];
}

export interface Access {
  /** Throw unless the caller holds `tier` on the target. Returns where it lives. */
  require<T extends Target>(tier: Tier, target: T): Promise<Located<T>>;
  /** Yes/no for branching. Sites only, so no lookup is needed. */
  can(tier: Tier, target: { site: string }): boolean;
  /**
   * The one site to list in: `siteId` if given, else the token's site.
   * PLANT lists need the tier on the plant; WORKCENTER lists narrow the
   * crew to their own cells.
   */
  list(tier: Tier, siteId?: string, kind?: "PLANT" | "WORKCENTER"): ListScope;
  /** Throw unless the caller holds `tier` at some plant (site-less rows, directories). */
  requireSomewhere(tier: Tier): void;
  /** Throw unless the caller owns the workspace (ENGINEER staff too, unless `allowStaff: false`). */
  requireOwner(options?: { allowStaff?: boolean }): void;
  /** Sites the caller can see: "all" or a list. */
  sites(): "all" | string[];
}

type Locate = typeof locateRow;

async function locate(
  target: Target,
  locateFn: Locate,
): Promise<{ siteId: string | null; workcenterId: string | null }> {
  if ("site" in target && typeof target.site === "string") return { siteId: target.site, workcenterId: null };
  const { kind, id } = rowRefParts(target as RowRef);
  const row = await locateFn(kind, id);
  if (!row) throw deny("NOT_FOUND", NOT_FOUND_MESSAGES[kind]);
  return { siteId: row.siteId, workcenterId: row.workcenterId ?? null };
}

// ── Users ────────────────────────────────────────────────────────────────

export class UserAccess implements Access {
  constructor(
    readonly person: Person,
    /** The token's active site: the default for lists. */
    private readonly tokenSiteId: string | null,
    private readonly locateFn: Locate = locateRow,
  ) {}

  async require<T extends Target>(tier: Tier, target: T): Promise<Located<T>> {
    const { siteId, workcenterId } = await locate(target, this.locateFn);
    if (siteId === null) {
      // A row attached to no site: reads need any site, changes need the
      // tier at some plant.
      this.requireSomewhere(tier);
      return { siteId: null } as Located<T>;
    }
    if (bypasses(this.person, tier)) return { siteId } as Located<T>;
    const held = workcenterId ? workcenterTier(this.person, workcenterId, siteId) : plantTier(this.person, siteId);
    if (!tierAtLeast(held, tier)) throw deny("FORBIDDEN", `Requires ${tier} access here`);
    return { siteId } as Located<T>;
  }

  can(tier: Tier, target: { site: string }): boolean {
    return bypasses(this.person, tier) || tierAtLeast(plantTier(this.person, target.site), tier);
  }

  list(tier: Tier, siteId?: string, kind: "PLANT" | "WORKCENTER" = "PLANT"): ListScope {
    const site = siteId ?? this.tokenSiteId;
    if (!site) throw deny("NO_WORKSPACE", "Site context required");
    if (bypasses(this.person, tier)) return { siteId: site };

    const plant = plantTier(this.person, site);
    if (kind === "PLANT") {
      if (tierAtLeast(plant, tier)) return { siteId: site };
      throw deny("FORBIDDEN", `Requires ${tier} access here`);
    }

    // Floor lists: plant managers see every cell; the crew see their own.
    if (tierAtLeast(plant, "MANAGE")) return { siteId: site };
    const workcenterIds = [...this.person.workcenters]
      .filter(([, wc]) => wc.siteId === site && tierAtLeast(wc.tier, tier))
      .map(([id]) => id);
    if (workcenterIds.length > 0) return { siteId: site, workcenterIds };
    throw deny("FORBIDDEN", `Requires ${tier} access here`);
  }

  requireSomewhere(tier: Tier): void {
    if (this.canSomewhere(tier)) return;
    throw deny("FORBIDDEN", tier === "VIEW" ? "No site access" : `Requires ${tier} access at some plant`);
  }

  /** Yes/no form of {@link requireSomewhere}. */
  canSomewhere(tier: Tier): boolean {
    if (bypasses(this.person, tier)) return true;
    if (tier === "VIEW") {
      const sites = visibleSites(this.person);
      return sites === "all" || sites.length > 0;
    }
    return [...this.person.plants.values()].some((held) => tierAtLeast(held, tier));
  }

  requireOwner(options: { allowStaff?: boolean } = {}): void {
    const allowStaff = options.allowStaff ?? true;
    if (this.person.owner || (allowStaff && this.person.staff === "ENGINEER")) return;
    throw deny("FORBIDDEN", "Reserved for the workspace owner");
  }

  sites(): "all" | string[] {
    return visibleSites(this.person);
  }
}

// ── Devices: displays and API tokens ─────────────────────────────────────

/**
 * Bound to one site. Displays may use any tier there (which procedures a
 * display can reach is the middleware's job); API tokens may only read.
 * Neither can act outside its site or at workspace level.
 */
export class DeviceAccess implements Access {
  constructor(
    private readonly kind: "display" | "app",
    private readonly siteId: string,
    private readonly locateFn: Locate = locateRow,
  ) {}

  private wrongSite(): AccessDenied {
    return deny(
      "FORBIDDEN",
      this.kind === "display" ? "Display can only access resources in its site" : "Token not authorized for this site",
    );
  }

  private checkTier(tier: Tier): void {
    if (this.kind === "app" && tier !== "VIEW") throw deny("FORBIDDEN", "Token is read-only");
  }

  async require<T extends Target>(tier: Tier, target: T): Promise<Located<T>> {
    const { siteId } = await locate(target, this.locateFn);
    if (siteId === null) throw deny("FORBIDDEN", "This action requires a user account");
    if (siteId !== this.siteId) throw this.wrongSite();
    this.checkTier(tier);
    return { siteId } as Located<T>;
  }

  can(tier: Tier, target: { site: string }): boolean {
    return target.site === this.siteId && (this.kind === "display" || tier === "VIEW");
  }

  list(tier: Tier, siteId?: string, _kind?: "PLANT" | "WORKCENTER"): ListScope {
    if (siteId && siteId !== this.siteId) throw this.wrongSite();
    this.checkTier(tier);
    return { siteId: this.siteId };
  }

  requireSomewhere(): void {
    throw deny("FORBIDDEN", "This action requires a user account");
  }

  requireOwner(): void {
    throw deny("FORBIDDEN", "Workspace-level actions require a user account");
  }

  sites(): string[] {
    return [this.siteId];
  }
}

// ── Describing access for screens ────────────────────────────────────────

/** How an entry got into the list: given directly, or by the two rules. */
export type AccessVia = "direct" | "member" | "cascade";

export interface AccessEntry {
  bucketId: string;
  kind: "PLANT" | "WORKCENTER";
  siteId: string;
  workcenterId: string | null;
  name: string;
  tier: Tier;
  via: AccessVia;
}

/**
 * Every bucket a person reaches, labelled with how. For screens only
 * (/users/me, "my buckets"); checks never read this. Owners and staff
 * reach everything, so they get an empty list.
 */
export async function describeAccess(person: Person): Promise<AccessEntry[]> {
  const sites = visibleSites(person);
  if (sites === "all" || sites.length === 0) return [];
  const buckets = await prisma.bucket.findMany({
    where: { siteId: { in: sites } },
    select: { id: true, name: true, kind: true, siteId: true, workcenterId: true },
  });

  const entries: AccessEntry[] = [];
  for (const b of buckets) {
    if (!b.siteId) continue;
    const base = { bucketId: b.id, kind: b.kind, siteId: b.siteId, workcenterId: b.workcenterId, name: b.name };
    if (b.kind === "PLANT") {
      const direct = person.plants.get(b.siteId);
      entries.push(direct ? { ...base, tier: direct, via: "direct" } : { ...base, tier: "VIEW", via: "member" });
    } else if (b.workcenterId) {
      const direct = person.workcenters.get(b.workcenterId)?.tier;
      const cascades = tierAtLeast(person.plants.get(b.siteId), "MANAGE");
      if (direct && (!cascades || tierAtLeast(direct, "MANAGE")))
        entries.push({ ...base, tier: direct, via: "direct" });
      else if (cascades) entries.push({ ...base, tier: "MANAGE", via: "cascade" });
    }
  }
  const order: Record<AccessVia, number> = { direct: 0, member: 1, cascade: 2 };
  return entries.sort((a, b) => order[a.via] - order[b.via]);
}

/** Staff standing as the wire has always spelled it. */
export function staffLabel(person: Person): "NONE" | "READ" | "FULL" {
  return person.staff === "SUPPORT" ? "READ" : person.staff === "ENGINEER" ? "FULL" : "NONE";
}

/** For requests with no valid credentials: every check fails. */
export const noAccess: Access = {
  require: async () => {
    throw deny("UNAUTHENTICATED", "Authentication required");
  },
  can: () => false,
  list: () => {
    throw deny("UNAUTHENTICATED", "Authentication required");
  },
  requireSomewhere: () => {
    throw deny("UNAUTHENTICATED", "Authentication required");
  },
  requireOwner: () => {
    throw deny("UNAUTHENTICATED", "Authentication required");
  },
  sites: () => [],
};

/** Prisma-shaped filter for a list: the site, and the crew's cells when narrowed. */
export function scopeWhere(scope: ListScope): {
  siteId: string;
  OR?: Array<{ workcenterId: { in: string[] } } | { workcenterId: null }>;
} {
  return scope.workcenterIds
    ? { siteId: scope.siteId, OR: [{ workcenterId: { in: scope.workcenterIds } }, { workcenterId: null }] }
    : { siteId: scope.siteId };
}

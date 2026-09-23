// Access — who may do what, asked of the current request.
//
// Like Basecamp's `Current.person`: the auth plugin builds one Access per
// request and handlers ask it. A "no" throws AccessDenied, which each
// transport maps to its wire error once.
//
// Users are checked against buckets:
//   PLANT (one per site)      VIEW = read the plant's shared things.
//                             MANAGE ("member") = also change them: jobs,
//                             orders, products, tools, dashboards…
//                             ADMIN = also set up the shop floor, people,
//                             access and settings, in every workcenter.
//   WORKCENTER (one per cell) VIEW = watch the floor. MANAGE = run the cell.
// A Person holds only the rows they were given. Two rules are worked out
// at check time:
//   - Any access at a site lets you read the plant (plant VIEW).
//   - Plant ADMIN means MANAGE on every workcenter at that site. A plant
//     member only reaches the workcenters they were given.
// Account admins and Rockware staff skip the buckets (the bypass below).
//
// Displays and API tokens stay simple: they are bound to one site. A
// display may do anything at its site that its procedures allow; an API
// token may only read.

import prisma from "@rw/db";
import { locateRow, NOT_FOUND_MESSAGES, rowRefParts, type RowRef, type SitelessRowKind } from "./rows.js";

export type Level = "VIEW" | "MANAGE" | "ADMIN";

export const LEVEL_RANK: Record<Level, number> = { VIEW: 1, MANAGE: 2, ADMIN: 3 };

export function levelAtLeast(held: Level | null | undefined, required: Level): boolean {
  return held != null && LEVEL_RANK[held] >= LEVEL_RANK[required];
}

function higher(a: Level | null, b: Level | null): Level | null {
  if (!a) return b;
  if (!b) return a;
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
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

/** A user's standing in the account: the rows they were given, nothing derived. */
export interface Person {
  /** Account admin: skips buckets, holds the account-only actions. */
  accountAdmin: boolean;
  /** Rockware staff: SUPPORT reads everywhere, ENGINEER manages everywhere. */
  staff: "SUPPORT" | "ENGINEER" | null;
  /** siteId → level on that site's PLANT bucket. */
  plants: Map<string, Level>;
  /** workcenterId → level on that cell's bucket, with the cell's site. */
  workcenters: Map<string, { siteId: string; level: Level }>;
}

export function emptyPerson(overrides: Partial<Person> = {}): Person {
  return { accountAdmin: false, staff: null, plants: new Map(), workcenters: new Map(), ...overrides };
}

/** Prisma select for the user fields a Person is built from. */
export const personSelect = {
  systemRole: true,
  isAccountAdmin: true,
  bucketAccesses: {
    select: { level: true, bucket: { select: { kind: true, siteId: true, workcenterId: true } } },
  },
} as const;

type PersonRows = {
  systemRole: "SUPPORT" | "ENGINEER" | null;
  isAccountAdmin: boolean;
  bucketAccesses: Array<{
    level: Level;
    bucket: { kind: "PLANT" | "WORKCENTER"; siteId: string | null; workcenterId: string | null };
  }>;
};

/** Turn a user row loaded with {@link personSelect} into a Person. */
export function toPerson(user: PersonRows): Person {
  if (user.systemRole) return emptyPerson({ staff: user.systemRole });
  if (user.isAccountAdmin) return emptyPerson({ accountAdmin: true });
  return personFromRows(
    user.bucketAccesses.map((a) => ({
      level: a.level,
      kind: a.bucket.kind,
      siteId: a.bucket.siteId,
      workcenterId: a.bucket.workcenterId,
    })),
  );
}

/** Load a user's person. Null when the user is missing. One query. */
export async function loadPerson(userId: string): Promise<Person | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: personSelect });
  return user ? toPerson(user) : null;
}

/** Build a person from BucketAccess rows (kept separate for tests). */
export function personFromRows(
  rows: Array<{ level: Level; kind: "PLANT" | "WORKCENTER"; siteId: string | null; workcenterId: string | null }>,
): Person {
  const person = emptyPerson();
  for (const row of rows) {
    if (!row.siteId) continue;
    if (row.kind === "PLANT") {
      person.plants.set(row.siteId, higher(person.plants.get(row.siteId) ?? null, row.level) as Level);
    } else if (row.workcenterId) {
      const held = person.workcenters.get(row.workcenterId)?.level ?? null;
      person.workcenters.set(row.workcenterId, { siteId: row.siteId, level: higher(held, row.level) as Level });
    }
  }
  return person;
}

/** The level held on a site's plant bucket, membership rule included. */
export function plantLevel(person: Person, siteId: string): Level | null {
  const direct = person.plants.get(siteId) ?? null;
  if (direct) return direct;
  for (const wc of person.workcenters.values()) {
    if (wc.siteId === siteId) return "VIEW";
  }
  return null;
}

/** Plant ADMIN reaches every workcenter at its site. */
function cascades(person: Person, siteId: string): boolean {
  return levelAtLeast(person.plants.get(siteId), "ADMIN");
}

/** The level held on one workcenter, plant cascade included. */
export function workcenterLevel(person: Person, workcenterId: string, siteId: string): Level | null {
  const direct = person.workcenters.get(workcenterId);
  const own = direct && direct.siteId === siteId ? direct.level : null;
  const cascade = cascades(person, siteId) ? "MANAGE" : null;
  return higher(own, cascade);
}

/** Sites where the person holds anything, or "all" for account admins and staff. */
export function visibleSites(person: Person): "all" | string[] {
  if (person.accountAdmin || person.staff) return "all";
  const ids = new Set(person.plants.keys());
  for (const wc of person.workcenters.values()) ids.add(wc.siteId);
  return [...ids];
}

/** The one place account admins and staff skip the buckets. */
function bypasses(person: Person, level: Level): boolean {
  return person.accountAdmin || person.staff === "ENGINEER" || (person.staff === "SUPPORT" && level === "VIEW");
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
  /**
   * Throw unless the caller holds `level` on the target. Returns where it lives.
   * ADMIN is always checked on the target's plant, even for floor rows.
   */
  require<T extends Target>(level: Level, target: T): Promise<Located<T>>;
  /** Yes/no for branching. Sites only, so no lookup is needed. */
  can(level: Level, target: { site: string }): boolean;
  /**
   * The one site to list in: `siteId` if given, else the token's site.
   * PLANT lists need the level on the plant; WORKCENTER lists narrow the
   * crew to their own cells.
   */
  list(level: Level, siteId?: string, kind?: "PLANT" | "WORKCENTER"): ListScope;
  /** Throw unless the caller holds `level` at some plant (site-less rows, directories). */
  requireSomewhere(level: Level): void;
  /** Throw unless the caller is an account admin (ENGINEER staff too, unless `allowStaff: false`). */
  requireAccountAdmin(options?: { allowStaff?: boolean }): void;
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

  async require<T extends Target>(level: Level, target: T): Promise<Located<T>> {
    const { siteId, workcenterId } = await locate(target, this.locateFn);
    if (siteId === null) {
      // A row attached to no site: reads need any site, changes need the
      // level at some plant.
      this.requireSomewhere(level);
      return { siteId: null } as Located<T>;
    }
    if (bypasses(this.person, level)) return { siteId } as Located<T>;
    // ADMIN is a plant level: setting up a station or workcenter asks the
    // row's plant, not its workcenter.
    const held =
      workcenterId && level !== "ADMIN"
        ? workcenterLevel(this.person, workcenterId, siteId)
        : plantLevel(this.person, siteId);
    if (!levelAtLeast(held, level)) throw deny("FORBIDDEN", `Requires ${level} access here`);
    return { siteId } as Located<T>;
  }

  can(level: Level, target: { site: string }): boolean {
    return bypasses(this.person, level) || levelAtLeast(plantLevel(this.person, target.site), level);
  }

  list(level: Level, siteId?: string, kind: "PLANT" | "WORKCENTER" = "PLANT"): ListScope {
    const site = siteId ?? this.tokenSiteId;
    if (!site) throw deny("NO_WORKSPACE", "Site context required");
    if (bypasses(this.person, level)) return { siteId: site };

    const plant = plantLevel(this.person, site);
    if (kind === "PLANT") {
      if (levelAtLeast(plant, level)) return { siteId: site };
      throw deny("FORBIDDEN", `Requires ${level} access here`);
    }

    // Floor lists: plant admins see every cell; everyone else sees their own.
    if (cascades(this.person, site)) return { siteId: site };
    const workcenterIds = [...this.person.workcenters]
      .filter(([, wc]) => wc.siteId === site && levelAtLeast(wc.level, level))
      .map(([id]) => id);
    if (workcenterIds.length > 0) return { siteId: site, workcenterIds };
    throw deny("FORBIDDEN", `Requires ${level} access here`);
  }

  requireSomewhere(level: Level): void {
    if (this.canSomewhere(level)) return;
    throw deny("FORBIDDEN", level === "VIEW" ? "No site access" : `Requires ${level} access at some plant`);
  }

  /** Yes/no form of {@link requireSomewhere}. */
  canSomewhere(level: Level): boolean {
    if (bypasses(this.person, level)) return true;
    if (level === "VIEW") {
      const sites = visibleSites(this.person);
      return sites === "all" || sites.length > 0;
    }
    return [...this.person.plants.values()].some((held) => levelAtLeast(held, level));
  }

  requireAccountAdmin(options: { allowStaff?: boolean } = {}): void {
    const allowStaff = options.allowStaff ?? true;
    if (this.person.accountAdmin || (allowStaff && this.person.staff === "ENGINEER")) return;
    throw deny("FORBIDDEN", "Reserved for account admins");
  }

  sites(): "all" | string[] {
    return visibleSites(this.person);
  }
}

// ── Devices: displays and API tokens ─────────────────────────────────────

/**
 * Bound to one site. Displays may use any level there (which procedures a
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

  private checkLevel(level: Level): void {
    if (this.kind === "app" && level !== "VIEW") throw deny("FORBIDDEN", "Token is read-only");
  }

  async require<T extends Target>(level: Level, target: T): Promise<Located<T>> {
    const { siteId } = await locate(target, this.locateFn);
    if (siteId === null) throw deny("FORBIDDEN", "This action requires a user account");
    if (siteId !== this.siteId) throw this.wrongSite();
    this.checkLevel(level);
    return { siteId } as Located<T>;
  }

  can(level: Level, target: { site: string }): boolean {
    return target.site === this.siteId && (this.kind === "display" || level === "VIEW");
  }

  list(level: Level, siteId?: string, _kind?: "PLANT" | "WORKCENTER"): ListScope {
    if (siteId && siteId !== this.siteId) throw this.wrongSite();
    this.checkLevel(level);
    return { siteId: this.siteId };
  }

  requireSomewhere(): void {
    throw deny("FORBIDDEN", "This action requires a user account");
  }

  requireAccountAdmin(): void {
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
  level: Level;
  via: AccessVia;
}

/**
 * Every bucket a person reaches, labelled with how. For screens only
 * (/users/me, "my buckets"); checks never read this. Account admins and staff
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
      entries.push(direct ? { ...base, level: direct, via: "direct" } : { ...base, level: "VIEW", via: "member" });
    } else if (b.workcenterId) {
      const direct = person.workcenters.get(b.workcenterId)?.level;
      const cascade = cascades(person, b.siteId);
      if (direct && (!cascade || levelAtLeast(direct, "MANAGE")))
        entries.push({ ...base, level: direct, via: "direct" });
      else if (cascade) entries.push({ ...base, level: "MANAGE", via: "cascade" });
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
  requireAccountAdmin: () => {
    throw deny("UNAUTHENTICATED", "Authentication required");
  },
  sites: () => [],
};

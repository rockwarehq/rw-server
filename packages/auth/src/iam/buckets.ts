// Bucket-based access control — the snapshot and its pure evaluators.
//
// Rows live in containers; access is membership in the container:
//   PLANT (one per site)      VIEW = member: read the common plant things.
//                             MANAGE = write the plant and everything in it
//                             (cascades to every workcenter at the site).
//                             ADMIN = people, access, dangerous settings.
//   WORKCENTER (one per cell) VIEW = watch the floor. MANAGE = operate and
//                             configure the cell.
//
// Two rules complete the model:
//   - Membership hook: ANY access at a site makes you a member of its
//     plant ("everyone at the plant is a member" is literal).
//   - Cascade: plant MANAGE/ADMIN implies MANAGE on every workcenter
//     bucket at that site, with zero per-cell rows.
//
// Above the buckets sit exactly two bypasses, like Basecamp account roles:
//   - WorkspaceMembership.workspaceRole = OWNER (reserved ownership).
//   - Rockware staff: SUPPORT reads everywhere, ENGINEER manages everywhere.
//
// The snapshot is loaded once per request by the auth plugin and evaluated
// by the pure functions below; policy.ts turns them into grant/deny
// decisions at the call sites.

import prisma from "@rw/db";

export type BucketKind = "PLANT" | "WORKCENTER";
export type BucketTier = "VIEW" | "MANAGE" | "ADMIN";

export const TIER_RANK: Record<BucketTier, number> = { VIEW: 1, MANAGE: 2, ADMIN: 3 };

export function tierAtLeast(held: BucketTier | null | undefined, required: BucketTier): boolean {
  return held != null && TIER_RANK[held] >= TIER_RANK[required];
}

/** How an entry got into the snapshot — useful for UIs, never for policy. */
export type BucketAccessVia = "direct" | "member" | "cascade";

export interface BucketEntry {
  bucketId: string;
  kind: BucketKind;
  siteId: string | null;
  workcenterId: string | null;
  tier: BucketTier;
  via: BucketAccessVia;
}

/**
 * Structural (no @rw/db types) so it can cross the context boundary —
 * the auth plugin stores it on IAMContext.bucketSnapshot.
 */
export interface BucketSnapshot {
  /** Reserved ownership: bypasses buckets, holds ownership-only operations. */
  owner: boolean;
  /** Rockware staff: "READ" sees everything, "FULL" manages everything. */
  staff: "NONE" | "READ" | "FULL";
  entries: BucketEntry[];
}

const EMPTY: readonly BucketEntry[] = [];

export function ownerSnapshot(): BucketSnapshot {
  return { owner: true, staff: "NONE", entries: [...EMPTY] };
}

export function staffSnapshot(systemRole: string): BucketSnapshot {
  return { owner: false, staff: systemRole === "SUPPORT" ? "READ" : "FULL", entries: [...EMPTY] };
}

/**
 * Apply the membership hook and the manage-cascade to the DIRECT access
 * rows plus the site's bucket inventory. Pure; exported for the plugin and
 * for tests.
 */
export function completeSnapshotEntries(
  direct: Array<Omit<BucketEntry, "via">>,
  siteBuckets: Array<{ id: string; kind: BucketKind; siteId: string | null; workcenterId: string | null }>,
): BucketEntry[] {
  const entries: BucketEntry[] = direct.map((e) => ({ ...e, via: "direct" }));
  const held = new Set(entries.map((e) => e.bucketId));

  // Membership hook: any access at a site ⇒ member of its plant.
  for (const b of siteBuckets) {
    if (b.kind === "PLANT" && !held.has(b.id)) {
      entries.push({
        bucketId: b.id,
        kind: "PLANT",
        siteId: b.siteId,
        workcenterId: null,
        tier: "VIEW",
        via: "member",
      });
      held.add(b.id);
    }
  }

  // Cascade: managing the plant is managing everything in it.
  const managedSites = new Set(
    entries.filter((e) => e.kind === "PLANT" && tierAtLeast(e.tier, "MANAGE")).map((e) => e.siteId),
  );
  for (const b of siteBuckets) {
    if (b.kind === "WORKCENTER" && managedSites.has(b.siteId)) {
      const existing = entries.find((e) => e.bucketId === b.id);
      if (existing) {
        if (!tierAtLeast(existing.tier, "MANAGE")) {
          existing.tier = "MANAGE";
          existing.via = "cascade";
        }
      } else {
        entries.push({
          bucketId: b.id,
          kind: "WORKCENTER",
          siteId: b.siteId,
          workcenterId: b.workcenterId,
          tier: "MANAGE",
          via: "cascade",
        });
        held.add(b.id);
      }
    }
  }

  return entries;
}

/**
 * Load the snapshot for a user's membership. Null when the user is
 * missing or has no membership in the workspace. Three queries; the auth
 * plugin calls this once per request.
 */
export async function loadBucketSnapshot(userId: string, workspaceId: string): Promise<BucketSnapshot | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { systemRole: true } });
  if (!user) return null;
  if (user.systemRole) return staffSnapshot(user.systemRole);

  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { id: true, workspaceRole: true },
  });
  if (!membership) return null;
  if (membership.workspaceRole === "OWNER") return ownerSnapshot();

  const accesses = await prisma.bucketAccess.findMany({
    where: { membershipId: membership.id },
    select: {
      tier: true,
      bucket: { select: { id: true, kind: true, siteId: true, workcenterId: true } },
    },
  });

  const direct = accesses.map((a) => ({
    bucketId: a.bucket.id,
    kind: a.bucket.kind as BucketKind,
    siteId: a.bucket.siteId,
    workcenterId: a.bucket.workcenterId,
    tier: a.tier as BucketTier,
  }));

  const siteIds = [...new Set(direct.map((e) => e.siteId).filter((s): s is string => s !== null))];
  const siteBuckets =
    siteIds.length === 0
      ? []
      : await prisma.bucket.findMany({
          where: { siteId: { in: siteIds } },
          select: { id: true, kind: true, siteId: true, workcenterId: true },
        });

  return {
    owner: false,
    staff: "NONE",
    entries: completeSnapshotEntries(direct, siteBuckets as never),
  };
}

// ── Pure evaluators ──────────────────────────────────────────────────────

/** The tier held in one bucket, bypasses excluded (policy handles those). */
export function snapshotTierInBucket(snapshot: BucketSnapshot, bucketId: string): BucketTier | null {
  let best: BucketTier | null = null;
  for (const e of snapshot.entries) {
    if (e.bucketId === bucketId && (!best || TIER_RANK[e.tier] > TIER_RANK[best])) best = e.tier;
  }
  return best;
}

/** The tier held on a site's PLANT bucket. */
export function snapshotPlantTier(snapshot: BucketSnapshot, siteId: string): BucketTier | null {
  let best: BucketTier | null = null;
  for (const e of snapshot.entries) {
    if (e.kind === "PLANT" && e.siteId === siteId && (!best || TIER_RANK[e.tier] > TIER_RANK[best])) best = e.tier;
  }
  return best;
}

/** The tier held on one workcenter's bucket (cascade included). */
export function snapshotWorkcenterTier(snapshot: BucketSnapshot, workcenterId: string): BucketTier | null {
  let best: BucketTier | null = null;
  for (const e of snapshot.entries) {
    if (e.workcenterId === workcenterId && (!best || TIER_RANK[e.tier] > TIER_RANK[best])) best = e.tier;
  }
  return best;
}

export type VisibleSites = { all: true } | { all: false; siteIds: string[] };

/** Sites where the principal holds any bucket — directory/token visibility. */
export function snapshotVisibleSites(snapshot: BucketSnapshot): VisibleSites {
  if (snapshot.owner || snapshot.staff !== "NONE") return { all: true };
  return { all: false, siteIds: [...new Set(snapshot.entries.map((e) => e.siteId).filter((s): s is string => !!s))] };
}

/** Workcenter ids at a site held at >= tier (cascade included). */
export function snapshotWorkcenterIds(snapshot: BucketSnapshot, siteId: string, tier: BucketTier): string[] {
  return [
    ...new Set(
      snapshot.entries
        .filter(
          (e) => e.kind === "WORKCENTER" && e.siteId === siteId && e.workcenterId !== null && tierAtLeast(e.tier, tier),
        )
        .map((e) => e.workcenterId as string),
    ),
  ];
}

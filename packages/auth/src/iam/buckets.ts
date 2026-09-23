// ─── SPIKE: Basecamp-bucket access model (throwaway exploration) ─────────
//
// The whole access model in one file. Every row belongs to exactly one
// bucket; a person's access is the set of buckets they are in, each with a
// tier (VIEW < WORK < MANAGE). There is no permission vocabulary: what you
// can do is decided by WHERE the thing lives and WHETHER you are in that
// bucket. Workspace owners/staff bypass, like Basecamp account roles.
//
// The one deliberate cheat: rows do not carry a bucketId column (that would
// mean backfilling 117 tables). The resolver derives the bucket from the
// ownership columns rows already have. Real adoption would add bucketId and
// collapse policy-resolvers.ts' 54 kinds into this one function.

import prisma from "@rw/db";
import { type IAMContext, Principal } from "../context.js";
import type { PolicyDenial } from "./policy.js";

export type BucketKind = "WORKCENTER" | "PLANT_OFFICE" | "PLANT_LIBRARY" | "PLANT_CONFIG";
export type BucketTier = "VIEW" | "WORK" | "MANAGE";

const TIER_RANK: Record<BucketTier, number> = { VIEW: 1, WORK: 2, MANAGE: 3 };

export interface BucketEntry {
  bucketId: string;
  kind: BucketKind;
  siteId: string | null;
  workcenterId: string | null;
  tier: BucketTier;
}

export interface BucketSnapshot {
  /** Workspace-level bypass: reserved ownership or Rockware staff. */
  admin: boolean;
  entries: BucketEntry[];
  byBucket: Map<string, BucketEntry>;
}

export interface BucketGrant {
  ok: true;
  workspaceId: string;
  siteId: string | null;
  bucketId: string;
}

export type BucketResult = BucketGrant | PolicyDenial;

/** Where a row lives. The spike derives this from existing ownership columns. */
export type BucketRef =
  | { kind: "bucket"; bucketId: string }
  | { kind: "workcenter"; workcenterId: string }
  | { kind: "station"; stationId: string }
  | { kind: "site"; siteId: string; area: Exclude<BucketKind, "WORKCENTER"> };

const deny = (code: PolicyDenial["code"], message: string): PolicyDenial => ({ ok: false, code, message });

// ── Snapshot ─────────────────────────────────────────────────────────────

export async function loadBucketSnapshot(userId: string, workspaceId: string): Promise<BucketSnapshot | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { systemRole: true } });
  if (!user) return null;
  if (user.systemRole) {
    // Spike simplification: staff bypass. A real design would keep SUPPORT
    // read-only (tier ceiling), which the bypass flag cannot express.
    return { admin: true, entries: [], byBucket: new Map() };
  }

  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { id: true },
  });
  if (!membership) return null;

  // Reserved ownership = the Basecamp account owner. No bucket rows.
  const owner = await prisma.roleAssignment.findFirst({
    where: { membershipId: membership.id, role: { permissions: { has: "owner:all" } } },
    select: { id: true },
  });
  if (owner) return { admin: true, entries: [], byBucket: new Map() };

  const accesses = await prisma.bucketAccess.findMany({
    where: { membershipId: membership.id },
    select: {
      tier: true,
      bucket: { select: { id: true, kind: true, siteId: true, workcenterId: true } },
    },
  });

  const entries: BucketEntry[] = accesses.map((a) => ({
    bucketId: a.bucket.id,
    kind: a.bucket.kind as BucketKind,
    siteId: a.bucket.siteId,
    workcenterId: a.bucket.workcenterId,
    tier: a.tier as BucketTier,
  }));

  // The Library hook: being in ANY bucket at a site confers VIEW on that
  // site's Library — shared catalogs are readable by every site member,
  // the way everyone on a Basecamp project can read its Docs & Files.
  const memberSiteIds = [...new Set(entries.map((e) => e.siteId).filter((s): s is string => s !== null))];
  if (memberSiteIds.length > 0) {
    const held = new Set(entries.map((e) => e.bucketId));
    const libraries = await prisma.bucket.findMany({
      where: { siteId: { in: memberSiteIds }, kind: "PLANT_LIBRARY" },
      select: { id: true, siteId: true, workcenterId: true },
    });
    for (const lib of libraries) {
      if (!held.has(lib.id)) {
        entries.push({
          bucketId: lib.id,
          kind: "PLANT_LIBRARY",
          siteId: lib.siteId,
          workcenterId: lib.workcenterId,
          tier: "VIEW",
        });
      }
    }
  }

  return { admin: false, entries, byBucket: new Map(entries.map((e) => [e.bucketId, e])) };
}

// ── The one resolver ─────────────────────────────────────────────────────

interface ResolvedBucket {
  bucketId: string;
  siteId: string | null;
}

/**
 * Row → bucket. This single function is what replaces the 54 per-kind
 * policy resolvers: everything reduces to "which container does this row
 * live in".
 */
async function resolveBucket(ref: BucketRef): Promise<ResolvedBucket | null> {
  switch (ref.kind) {
    case "bucket": {
      const b = await prisma.bucket.findUnique({ where: { id: ref.bucketId }, select: { id: true, siteId: true } });
      return b ? { bucketId: b.id, siteId: b.siteId } : null;
    }
    case "workcenter": {
      const b = await prisma.bucket.findUnique({
        where: { workcenterId: ref.workcenterId },
        select: { id: true, siteId: true },
      });
      return b ? { bucketId: b.id, siteId: b.siteId } : null;
    }
    case "station": {
      // A station with no workcenter has NO bucket. Under the old model
      // "workcenterId IS NULL" meant readable site-wide; under buckets an
      // unbucketed row is invisible to everyone but workspace admins. The
      // spike keeps that consequence on purpose — feel it in the tests.
      const station = await prisma.station.findUnique({
        where: { id: ref.stationId },
        select: { workcenterId: true },
      });
      if (!station?.workcenterId) return null;
      return resolveBucket({ kind: "workcenter", workcenterId: station.workcenterId });
    }
    case "site": {
      const b = await prisma.bucket.findFirst({
        where: { siteId: ref.siteId, kind: ref.area },
        select: { id: true, siteId: true },
      });
      return b ? { bucketId: b.id, siteId: b.siteId } : null;
    }
  }
}

// ── The one gate ─────────────────────────────────────────────────────────

/**
 * Basecamp's controller gate: can this principal act in this row's bucket
 * at this tier? One membership lookup — no permission strings anywhere.
 */
export async function authorizeBucketTier(
  iam: IAMContext | undefined,
  check: { ref: BucketRef; tier: BucketTier },
): Promise<BucketResult> {
  if (!iam?.validToken) return deny("UNAUTHENTICATED", "Authentication required");
  if (iam.principal !== Principal.USER && iam.principal !== Principal.DISPLAY && iam.principal !== Principal.APP) {
    return deny("UNAUTHENTICATED", "Authentication required");
  }
  const workspaceId = iam.workspaceId;
  if (!workspaceId) return deny("NO_WORKSPACE", "Workspace context required");

  const resolved = await resolveBucket(check.ref);
  if (!resolved) return deny("NOT_FOUND", "No bucket owns this row");

  // Devices are site-bound, exactly as before: a display is implicitly in
  // every bucket of its own site. (A real design would bucket-bind devices.)
  if (iam.principal !== Principal.USER) {
    if (!resolved.siteId || iam.siteId !== resolved.siteId) {
      return deny("FORBIDDEN", "Device can only access buckets in its site");
    }
    return { ok: true, workspaceId, siteId: resolved.siteId, bucketId: resolved.bucketId };
  }

  const snapshot = await loadBucketSnapshot(iam.id as string, workspaceId);
  if (!snapshot) return deny("FORBIDDEN", "No workspace membership");
  if (snapshot.admin) return { ok: true, workspaceId, siteId: resolved.siteId, bucketId: resolved.bucketId };

  const entry = snapshot.byBucket.get(resolved.bucketId);
  if (!entry || TIER_RANK[entry.tier] < TIER_RANK[check.tier]) {
    return deny("FORBIDDEN", `Not in this bucket at tier ${check.tier}`);
  }
  return { ok: true, workspaceId, siteId: resolved.siteId, bucketId: resolved.bucketId };
}

// ── Visibility helpers (lists, trees, pickers) ───────────────────────────

/** Sites where the principal holds any bucket — the "my projects" list. */
export async function bucketVisibleSiteIds(userId: string, workspaceId: string): Promise<"all" | string[]> {
  const snapshot = await loadBucketSnapshot(userId, workspaceId);
  if (!snapshot) return [];
  if (snapshot.admin) return "all";
  return [...new Set(snapshot.entries.map((e) => e.siteId).filter((s): s is string => s !== null))];
}

/** Workcenter ids (at a site) whose buckets the principal is in at >= tier. */
export function bucketWorkcenterIds(snapshot: BucketSnapshot, siteId: string, tier: BucketTier): string[] {
  return snapshot.entries
    .filter(
      (e) =>
        e.kind === "WORKCENTER" &&
        e.siteId === siteId &&
        e.workcenterId !== null &&
        TIER_RANK[e.tier] >= TIER_RANK[tier],
    )
    .map((e) => e.workcenterId as string);
}

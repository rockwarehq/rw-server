// ─── SPIKE: Basecamp-bucket access model, v3 (throwaway) ─────────────────
//
// The whole access model in one file, two container kinds:
//
//   PLANT (one per site)   — everyone at the plant is a member.
//     VIEW   member: read all the common plant things.
//     MANAGE write the plant and everything in it (cascades to every
//            workcenter bucket at the site).
//     ADMIN  the reserved shelf: people, access, dangerous settings.
//   WORKCENTER (one per WC) — the crew.
//     VIEW   watch this cell's floor.
//     WORK   operate it.
//
// Workspace owners (owner:all) and Rockware staff bypass, like the Basecamp
// account owner. No permission vocabulary anywhere.
//
// The one deliberate cheat: rows do not carry a bucketId column (that would
// mean backfilling 117 tables). The resolver derives the bucket from the
// ownership columns rows already have. Real adoption would add bucketId and
// collapse policy-resolvers.ts' 54 kinds into this one function.

import prisma from "@rw/db";
import { type IAMContext, Principal } from "../context.js";
import type { PolicyDenial } from "./policy.js";

export type BucketKind = "PLANT" | "WORKCENTER";
export type BucketTier = "VIEW" | "WORK" | "MANAGE" | "ADMIN";

const TIER_RANK: Record<BucketTier, number> = { VIEW: 1, WORK: 2, MANAGE: 3, ADMIN: 4 };

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
  | { kind: "plant"; siteId: string }
  /** A row no bucket owns (null-site pool rows): owner territory. */
  | { kind: "unhomed" };

const deny = (code: PolicyDenial["code"], message: string): PolicyDenial => ({ ok: false, code, message });

// ── Snapshot ─────────────────────────────────────────────────────────────

export async function loadBucketSnapshot(userId: string, workspaceId: string): Promise<BucketSnapshot | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { systemRole: true } });
  if (!user) return null;
  if (user.systemRole) {
    // Spike simplification: staff bypass. A real design would keep SUPPORT
    // read-only (a tier ceiling), which a bypass flag cannot express.
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

  const held = new Set(entries.map((e) => e.bucketId));
  const siteIds = [...new Set(entries.map((e) => e.siteId).filter((s): s is string => s !== null))];
  if (siteIds.length > 0) {
    const siteBuckets = await prisma.bucket.findMany({
      where: { siteId: { in: siteIds } },
      select: { id: true, kind: true, siteId: true, workcenterId: true },
    });

    // Membership hook: ANY access at a site makes you a member of its
    // plant — "everyone at the plant is a member" is literal, including
    // grant-only crew.
    for (const b of siteBuckets) {
      if (b.kind === "PLANT" && !held.has(b.id)) {
        entries.push({ bucketId: b.id, kind: "PLANT", siteId: b.siteId, workcenterId: null, tier: "VIEW" });
        held.add(b.id);
      }
    }

    // Cascade: managing the plant means managing everything in it — every
    // workcenter bucket at the site, without per-cell rows.
    const managedSites = new Set(
      entries.filter((e) => e.kind === "PLANT" && TIER_RANK[e.tier] >= TIER_RANK.MANAGE).map((e) => e.siteId),
    );
    for (const b of siteBuckets) {
      if (b.kind === "WORKCENTER" && managedSites.has(b.siteId) && !held.has(b.id)) {
        entries.push({
          bucketId: b.id,
          kind: "WORKCENTER",
          siteId: b.siteId,
          workcenterId: b.workcenterId,
          tier: "MANAGE",
        });
        held.add(b.id);
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
      // A station with no workcenter has NO bucket: only workspace owners
      // can touch it (the bypass runs before resolution). The old model's
      // "workcenterId IS NULL means readable site-wide" hatch is gone.
      const station = await prisma.station.findUnique({
        where: { id: ref.stationId },
        select: { workcenterId: true },
      });
      if (!station?.workcenterId) return null;
      return resolveBucket({ kind: "workcenter", workcenterId: station.workcenterId });
    }
    case "plant": {
      const b = await prisma.bucket.findFirst({
        where: { siteId: ref.siteId, kind: "PLANT" },
        select: { id: true, siteId: true },
      });
      return b ? { bucketId: b.id, siteId: b.siteId } : null;
    }
    case "unhomed":
      return null;
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

  // Owners and staff bypass BEFORE resolution, so rows no bucket owns
  // (device pool, workcenter-less stations) are owner-territory instead of
  // universally invisible.
  let snapshot: BucketSnapshot | null = null;
  if (iam.principal === Principal.USER) {
    snapshot = await loadBucketSnapshot(iam.id as string, workspaceId);
    if (!snapshot) return deny("FORBIDDEN", "No workspace membership");
  }

  const resolved = await resolveBucket(check.ref);
  if (!resolved) {
    if (snapshot?.admin) {
      return { ok: true, workspaceId, siteId: null, bucketId: "unhomed" };
    }
    return deny("NOT_FOUND", "No bucket owns this row");
  }

  // Devices are site-bound, exactly as before: a display is implicitly in
  // every bucket of its own site. (A real design would bucket-bind devices.)
  if (iam.principal !== Principal.USER) {
    if (!resolved.siteId || iam.siteId !== resolved.siteId) {
      return deny("FORBIDDEN", "Device can only access buckets in its site");
    }
    return { ok: true, workspaceId, siteId: resolved.siteId, bucketId: resolved.bucketId };
  }

  if (snapshot?.admin) return { ok: true, workspaceId, siteId: resolved.siteId, bucketId: resolved.bucketId };

  const entry = snapshot?.byBucket.get(resolved.bucketId);
  if (!entry || TIER_RANK[entry.tier] < TIER_RANK[check.tier]) {
    return deny("FORBIDDEN", `Not in this bucket at tier ${check.tier}`);
  }
  return { ok: true, workspaceId, siteId: resolved.siteId, bucketId: resolved.bucketId };
}

// ── Visibility helpers (lists, trees, pickers) ───────────────────────────

/** Sites where the principal holds any bucket — the "my plants" list. */
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

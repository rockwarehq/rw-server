import { describe, expect, it } from "vitest";
import {
  type BucketSnapshot,
  completeSnapshotEntries,
  ownerSnapshot,
  snapshotPlantTier,
  snapshotVisibleSites,
  snapshotWorkcenterIds,
  snapshotWorkcenterTier,
  staffSnapshot,
  tierAtLeast,
} from "./buckets.js";

const SITE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SITE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLANT_A = "0a000000-0000-4000-8000-000000000001";
const PLANT_B = "0b000000-0000-4000-8000-000000000001";
const WC_1 = "11111111-1111-4111-8111-111111111111";
const WC_2 = "22222222-2222-4222-8222-222222222222";
const WCB_1 = "0c000000-0000-4000-8000-000000000001";
const WCB_2 = "0c000000-0000-4000-8000-000000000002";

const SITE_BUCKETS = [
  { id: PLANT_A, kind: "PLANT" as const, siteId: SITE_A, workcenterId: null },
  { id: WCB_1, kind: "WORKCENTER" as const, siteId: SITE_A, workcenterId: WC_1 },
  { id: WCB_2, kind: "WORKCENTER" as const, siteId: SITE_A, workcenterId: WC_2 },
];

const snap = (entries: BucketSnapshot["entries"]): BucketSnapshot => ({ owner: false, staff: "NONE", entries });

describe("tierAtLeast", () => {
  it("orders VIEW < MANAGE < ADMIN and fails closed on null", () => {
    expect(tierAtLeast("MANAGE", "VIEW")).toBe(true);
    expect(tierAtLeast("VIEW", "MANAGE")).toBe(false);
    expect(tierAtLeast("ADMIN", "MANAGE")).toBe(true);
    expect(tierAtLeast(null, "VIEW")).toBe(false);
  });
});

describe("completeSnapshotEntries", () => {
  it("membership hook: any workcenter access makes you a plant member", () => {
    const entries = completeSnapshotEntries(
      [{ bucketId: WCB_1, kind: "WORKCENTER", siteId: SITE_A, workcenterId: WC_1, tier: "MANAGE" }],
      SITE_BUCKETS,
    );
    const plant = entries.find((e) => e.bucketId === PLANT_A);
    expect(plant).toMatchObject({ tier: "VIEW", via: "member" });
  });

  it("cascade: plant MANAGE implies MANAGE on every workcenter bucket at the site", () => {
    const entries = completeSnapshotEntries(
      [{ bucketId: PLANT_A, kind: "PLANT", siteId: SITE_A, workcenterId: null, tier: "MANAGE" }],
      SITE_BUCKETS,
    );
    const wcs = entries.filter((e) => e.kind === "WORKCENTER");
    expect(wcs.map((e) => `${e.tier}:${e.via}`).sort()).toEqual(["MANAGE:cascade", "MANAGE:cascade"]);
  });

  it("cascade upgrades a weaker direct crew entry but never downgrades", () => {
    const entries = completeSnapshotEntries(
      [
        { bucketId: PLANT_A, kind: "PLANT", siteId: SITE_A, workcenterId: null, tier: "ADMIN" },
        { bucketId: WCB_1, kind: "WORKCENTER", siteId: SITE_A, workcenterId: WC_1, tier: "VIEW" },
      ],
      SITE_BUCKETS,
    );
    expect(entries.find((e) => e.bucketId === WCB_1)).toMatchObject({ tier: "MANAGE" });
  });

  it("a plain plant member gets no workcenter entries", () => {
    const entries = completeSnapshotEntries(
      [{ bucketId: PLANT_A, kind: "PLANT", siteId: SITE_A, workcenterId: null, tier: "VIEW" }],
      SITE_BUCKETS,
    );
    expect(entries.filter((e) => e.kind === "WORKCENTER")).toEqual([]);
  });
});

describe("pure evaluators", () => {
  const crew = snap(
    completeSnapshotEntries(
      [{ bucketId: WCB_1, kind: "WORKCENTER", siteId: SITE_A, workcenterId: WC_1, tier: "MANAGE" }],
      SITE_BUCKETS,
    ),
  );
  const manager = snap(
    completeSnapshotEntries(
      [{ bucketId: PLANT_A, kind: "PLANT", siteId: SITE_A, workcenterId: null, tier: "MANAGE" }],
      SITE_BUCKETS,
    ),
  );

  it("plant tier: crew are members via the hook; managers hold MANAGE", () => {
    expect(snapshotPlantTier(crew, SITE_A)).toBe("VIEW");
    expect(snapshotPlantTier(manager, SITE_A)).toBe("MANAGE");
    expect(snapshotPlantTier(crew, SITE_B)).toBeNull();
  });

  it("workcenter tier: crew manage their cell only; managers manage all cells", () => {
    expect(snapshotWorkcenterTier(crew, WC_1)).toBe("MANAGE");
    expect(snapshotWorkcenterTier(crew, WC_2)).toBeNull();
    expect(snapshotWorkcenterTier(manager, WC_1)).toBe("MANAGE");
    expect(snapshotWorkcenterTier(manager, WC_2)).toBe("MANAGE");
  });

  it("visible sites are the union of held buckets; owner/staff see all", () => {
    expect(snapshotVisibleSites(crew)).toEqual({ all: false, siteIds: [SITE_A] });
    expect(snapshotVisibleSites(snap([]))).toEqual({ all: false, siteIds: [] });
    expect(snapshotVisibleSites(ownerSnapshot())).toEqual({ all: true });
    expect(snapshotVisibleSites(staffSnapshot("SUPPORT"))).toEqual({ all: true });
  });

  it("workcenter ids narrow by tier", () => {
    expect(snapshotWorkcenterIds(crew, SITE_A, "MANAGE")).toEqual([WC_1]);
    expect(snapshotWorkcenterIds(crew, SITE_A, "VIEW")).toEqual([WC_1]);
    expect(new Set(snapshotWorkcenterIds(manager, SITE_A, "MANAGE"))).toEqual(new Set([WC_1, WC_2]));
    expect(snapshotWorkcenterIds(crew, SITE_B, "VIEW")).toEqual([]);
  });

  it("staff snapshots: SUPPORT reads, ENGINEER manages", () => {
    expect(staffSnapshot("SUPPORT").staff).toBe("READ");
    expect(staffSnapshot("ENGINEER").staff).toBe("FULL");
  });
});

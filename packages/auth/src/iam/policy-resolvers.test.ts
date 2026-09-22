import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({
  station: { findUnique: vi.fn() },
  workcenter: { findUnique: vi.fn() },
  stationStateLog: { findUnique: vi.fn() },
  stationJobLog: { findUnique: vi.fn() },
  stationModeLog: { findUnique: vi.fn() },
  stationLogonSession: { findUnique: vi.fn() },
  call: { findUnique: vi.fn() },
  cycle: { findUnique: vi.fn() },
  itemDispositionLog: { findUnique: vi.fn() },
  inventoryItem: { findUnique: vi.fn() },
  shiftAssignment: { findUnique: vi.fn() },
  shiftInstance: { findUnique: vi.fn() },
}));
vi.mock("@rw/db", () => ({ default: db }));
import { resolveSiteRef } from "./policy-resolvers.js";

beforeEach(() => vi.resetAllMocks());
const lineage = { siteId: "site", workcenterId: "wc", stationId: "station" };

describe("resource lineage", () => {
  it("station and workcenter references carry the ID that was actually resolved", async () => {
    db.station.findUnique.mockResolvedValue({ siteId: "site", workcenterId: "wc" });
    expect(await resolveSiteRef({ kind: "station", id: "station" })).toEqual(lineage);
    db.workcenter.findUnique.mockResolvedValue({ siteId: "site" });
    expect(await resolveSiteRef({ kind: "workcenter", id: "wc" })).toEqual({ siteId: "site", workcenterId: "wc" });
    db.station.findUnique.mockResolvedValue(null);
    expect(await resolveSiteRef({ kind: "station", id: "missing" })).toBeNull();
  });

  it.each([
    "call",
    "cycle",
    "dispositionLog",
  ] as const)("%s includes station and WC lineage in the narrow query", async (kind) => {
    const delegate = kind === "dispositionLog" ? db.itemDispositionLog : db[kind];
    delegate.findUnique.mockResolvedValue(lineage);
    expect(await resolveSiteRef({ kind, id: "row" })).toEqual(lineage);
    expect(delegate.findUnique).toHaveBeenCalledWith({
      where: { id: "row" },
      select: { siteId: true, workcenterId: true, stationId: true },
    });
  });

  it.each([
    "stationStateLog",
    "stationJobLog",
    "stationModeLog",
    "stationLogonSession",
  ] as const)("%s keeps historical WC scope and resolves legacy null-site rows through the station", async (kind) => {
    db[kind].findUnique.mockResolvedValue({ ...lineage, station: { siteId: "site" } });
    expect(await resolveSiteRef({ kind, id: "row" })).toEqual(lineage);
    db[kind].findUnique.mockResolvedValue({
      ...lineage,
      siteId: null,
      workcenterId: null,
      station: { siteId: "site" },
    });
    expect(await resolveSiteRef({ kind, id: "legacy-row" })).toEqual({ ...lineage, workcenterId: null });
  });

  it("inventory items use their required cycle to resolve station/WC even without denormalized dimensions", async () => {
    db.inventoryItem.findUnique.mockResolvedValue({ cycle: lineage });
    expect(await resolveSiteRef({ kind: "inventoryItem", id: "item" })).toEqual(lineage);
    expect(db.inventoryItem.findUnique).toHaveBeenCalledWith({
      where: { id: "item" },
      select: {
        cycle: { select: { siteId: true, workcenterId: true, stationId: true } },
      },
    });
  });

  it.each([
    "shiftAssignment",
    "shiftInstance",
  ] as const)("%s normalizes workCenterId without losing null scope", async (kind) => {
    db[kind].findUnique.mockResolvedValue({ siteId: "site", workCenterId: "wc" });
    expect(await resolveSiteRef({ kind, id: "shift" })).toEqual({ siteId: "site", workcenterId: "wc" });
    db[kind].findUnique.mockResolvedValue({ siteId: "site", workCenterId: null });
    expect(await resolveSiteRef({ kind, id: "shift" })).toEqual({ siteId: "site", workcenterId: null });
  });
});

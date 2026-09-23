import { beforeEach, describe, expect, it, vi } from "vitest";

// Floor lists must narrow a crew-only caller to their own cells (plus rows
// in no cell). Prisma is mocked: this checks the where clause each list
// builds, not the database.
const db = vi.hoisted(() => ({
  inventoryItem: { findMany: vi.fn(), count: vi.fn() },
  itemDispositionLog: { findMany: vi.fn(), count: vi.fn() },
}));
vi.mock("@rw/db", async (importOriginal) => ({ ...(await importOriginal<object>()), default: db }));

const { list: listInventory } = await import("../inventory/inventory.js");
const { list: listDispositionLogs } = await import("../inventory/disposition-log.js");

const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WC = "11111111-1111-4111-8111-111111111111";
const CREW_OR = [{ workcenterId: { in: [WC] } }, { workcenterId: null }];

beforeEach(() => {
  for (const model of Object.values(db)) {
    model.findMany.mockResolvedValue([]);
    model.count.mockResolvedValue(0);
  }
});

describe("crew narrowing on floor lists", () => {
  it("inventory items: crew see their cells and cell-less rows", async () => {
    await listInventory({ siteId: SITE, workcenterIds: [WC] });
    expect(db.inventoryItem.findMany.mock.lastCall?.[0].where.OR).toEqual(CREW_OR);
  });

  it("disposition logs: crew see their cells and cell-less rows", async () => {
    await listDispositionLogs({ siteId: SITE, workcenterIds: [WC] });
    expect(db.itemDispositionLog.findMany.mock.lastCall?.[0].where.OR).toEqual(CREW_OR);
  });

  it("whole-floor callers are not narrowed", async () => {
    await listInventory({ siteId: SITE });
    await listDispositionLogs({ siteId: SITE });
    expect(db.inventoryItem.findMany.mock.lastCall?.[0].where.OR).toBeUndefined();
    expect(db.itemDispositionLog.findMany.mock.lastCall?.[0].where.OR).toBeUndefined();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  shiftInstance: { findUnique: vi.fn() },
  workcenter: { findUnique: vi.fn() },
  shiftSignoff: { findUnique: vi.fn(), create: vi.fn() },
}));
vi.mock("@rw/db", () => ({ default: db }));
import { create } from "./shift-signoff.js";

const input = { siteId: "site", shiftInstanceId: "shift", workcenterId: "workcenter", postedById: "user" };

beforeEach(() => {
  vi.resetAllMocks();
  db.shiftInstance.findUnique.mockResolvedValue({ siteId: "site", workCenterId: null });
  db.workcenter.findUnique.mockResolvedValue({ siteId: "site" });
  db.shiftSignoff.findUnique.mockResolvedValue(null);
  db.shiftSignoff.create.mockResolvedValue({ id: "signoff", ...input, postedBy: { id: "user" } });
});

describe("shift sign-off validation and service results", () => {
  it("preserves site mismatch precedence and never writes invalid related ids", async () => {
    const result = await create({ ...input, siteId: "other-site" });
    expect(result.code).toBe("SITE_MISMATCH");
    expect(result.data).toBeUndefined();
    expect(db.workcenter.findUnique).not.toHaveBeenCalled();
    expect(db.shiftSignoff.create).not.toHaveBeenCalled();
  });

  it("rejects a foreign workcenter even for a shared site-level shift", async () => {
    db.workcenter.findUnique.mockResolvedValue({ siteId: "other-site" });
    const result = await create(input);
    expect(result.code).toBe("WORKCENTER_MISMATCH");
    expect(db.shiftSignoff.create).not.toHaveBeenCalled();
  });

  it("returns the typed poster DTO and only resolves the shift once", async () => {
    const result = await create(input);
    if (result.error !== undefined) throw new Error(result.error);
    expect(result.data.postedBy?.id).toBe("user");
    expect(db.shiftInstance.findUnique).toHaveBeenCalledTimes(1);
  });
});

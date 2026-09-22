import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({
  station: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), delete: vi.fn() },
  display: { count: vi.fn() },
}));
vi.mock("@rw/db", () => ({ default: db }));
vi.mock("../../entity/events.js", () => ({ publishEntityEvent: vi.fn() }));
import { list, remove } from "./crud.js";

beforeEach(() => {
  vi.resetAllMocks();
  db.station.findUnique.mockResolvedValue({ id: "station", siteId: "site", site: { workspaceId: "workspace" } });
  db.station.findMany.mockResolvedValue([]);
  db.station.count.mockResolvedValue(0);
  db.display.count.mockResolvedValue(0);
});

describe("station terminal scope protection", () => {
  it("intersects account workcenters, requested workcenter and fixed station before pagination/count", async () => {
    await list({ siteId: "site", workcenterId: "requested", workcenterIds: ["allowed"], stationId: "station" });
    const where = db.station.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      siteId: "site",
      id: "station",
      workcenterId: "requested",
      AND: [{ workcenterId: { in: ["allowed"] } }],
    });
    expect(db.station.count).toHaveBeenCalledWith({ where });
  });
  it("requires explicit unassignment before deleting a bound station", async () => {
    db.display.count.mockResolvedValue(1);
    expect(await remove("station", "workspace")).toMatchObject({ code: "DISPLAY_STATION_BOUND" });
    expect(db.station.delete).not.toHaveBeenCalled();
  });
  it("maps a concurrent display assignment FK conflict to the same actionable conflict", async () => {
    db.display.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    db.station.delete.mockRejectedValue({ code: "P2003" });
    expect(await remove("station", "workspace")).toMatchObject({ code: "DISPLAY_STATION_BOUND" });
  });
  it("maps PostgreSQL 18's raw RESTRICT violation after a concurrent assignment", async () => {
    db.display.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    db.station.delete.mockRejectedValue({
      name: "DriverAdapterError",
      cause: { code: "23001", originalCode: "23001" },
    });
    expect(await remove("station", "workspace")).toMatchObject({ code: "DISPLAY_STATION_BOUND" });
  });
  it("allows deletion once displays have been explicitly detached", async () => {
    expect(await remove("station", "workspace")).toEqual({ success: true });
    expect(db.station.delete).toHaveBeenCalledWith({ where: { id: "station" } });
  });
});

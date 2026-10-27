import { Prisma } from "@rw/db";
import { describe, expect, it, vi } from "vitest";

import { resolveEffectiveStandards, type StationStandardsFields } from "./effective-standards.js";

const stationVersion: StationStandardsFields = {
  cycleMode: "DISCRETE",
  standardQuantity: new Prisma.Decimal(2),
  quantityUnit: "",
  standardCycle: new Prisma.Decimal(30),
  standardRate: null,
  standardRateUnit: "",
  standardRatePeriod: "MINUTE",
};

function client() {
  return {
    stationVersion: { findFirst: vi.fn(async () => stationVersion) },
    jobVersion: {
      findFirst: vi.fn(async () => ({
        standardCycle: new Prisma.Decimal(20),
        standardRate: null,
        standardRateUnit: "",
        standardRatePeriod: "MINUTE",
      })),
    },
  };
}

describe("resolveEffectiveStandards", () => {
  it("reads the station's current version when none is passed", async () => {
    const db = client();
    await resolveEffectiveStandards(db as never, "station-1", "job-1");
    expect(db.stationVersion.findFirst).toHaveBeenCalledTimes(1);
  });

  it("uses a passed station version instead of reading it again, with the same result", async () => {
    const read = await resolveEffectiveStandards(client() as never, "station-1", "job-1");
    const db = client();
    const passed = await resolveEffectiveStandards(db as never, "station-1", "job-1", stationVersion);

    expect(db.stationVersion.findFirst).not.toHaveBeenCalled();
    expect(passed).toEqual(read);
  });

  it("treats a passed null as a station with no current version", async () => {
    const db = client();
    db.stationVersion.findFirst.mockResolvedValue(null as never);
    const read = await resolveEffectiveStandards(db as never, "station-1", "job-1");
    const passed = await resolveEffectiveStandards(client() as never, "station-1", "job-1", null);
    expect(passed).toEqual(read);
  });
});

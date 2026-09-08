import { describe, expect, test, vi } from "vitest";
import { encodeSnapshotPageToken, resolveSnapshotPage } from "./page-token.js";
import { isHistorianError } from "./types.js";

const scope = { siteId: "site", stationId: "station" };
const range = { from: new Date("2026-07-13T06:00:00Z"), to: null };
const keyset = Buffer.from(JSON.stringify({ s: range.from.getTime(), i: "row-2" })).toString("base64url");

describe("snapshot page tokens", () => {
  test.each([null, new Date("2026-07-13T14:00:00Z")])("pins the initial resolved range with end %s", async (to) => {
    const window = { range: { ...range, to }, shift: null };
    const resolver = vi.fn().mockResolvedValue({ range: { from: new Date(), to: null }, shift: null });
    const token = encodeSnapshotPageToken("stationState", scope, window, keyset);
    const page = await resolveSnapshotPage("stationState", scope, token, resolver);
    expect(page).toEqual({ ...window, pageToken: keyset });
    expect(resolver).not.toHaveBeenCalled();
  });

  test("keeps the original shift even after rollover or when no shift is active", async () => {
    const window = {
      range,
      shift: {
        range,
        shiftInstanceId: "shift-1",
        shiftName: "Morning",
        shiftStart: range.from,
        shiftEnd: new Date("2026-07-13T14:00:00Z"),
      },
    };
    const token = encodeSnapshotPageToken("stationState", scope, window, keyset);
    const resolver = vi.fn().mockResolvedValue(null);
    expect(await resolveSnapshotPage("stationState", scope, token, resolver)).toEqual({ ...window, pageToken: keyset });
    expect(resolver).not.toHaveBeenCalled();
  });

  test("resolves first pages and continues accepting shipped keyset-only tokens", async () => {
    const resolver = vi.fn().mockResolvedValue({ range, shift: null });
    expect(await resolveSnapshotPage("stationState", scope, undefined, resolver)).toEqual({
      range,
      shift: null,
      pageToken: null,
    });
    expect(await resolveSnapshotPage("stationState", scope, keyset, resolver)).toEqual({
      range,
      shift: null,
      pageToken: keyset,
    });
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(await resolveSnapshotPage("stationState", scope, undefined, async () => null)).toBeNull();
  });

  test("rejects malformed or cross-scope tokens without resolving a new range", async () => {
    const resolver = vi.fn();
    const token = encodeSnapshotPageToken("stationState", scope, { range, shift: null }, keyset);
    for (const bad of ["bad-token", Buffer.from('{"v":99,"kind":"snapshot"}').toString("base64url"), token]) {
      expect(
        isHistorianError(await resolveSnapshotPage("stationState", { ...scope, stationId: "other" }, bad, resolver)),
      ).toBe(true);
    }
    expect(resolver).not.toHaveBeenCalled();
  });

  test("does not turn resolver failures into bad-cursor errors", async () => {
    await expect(
      resolveSnapshotPage("stationState", scope, keyset, async () => {
        throw new Error("database unavailable");
      }),
    ).rejects.toThrow("database unavailable");
  });
});

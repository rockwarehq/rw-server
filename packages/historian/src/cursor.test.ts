import { describe, expect, test } from "vitest";
import { CURSOR_TTL_MS, cursorFingerprint, decodeCursor, encodeCursor } from "./cursor.js";
import { isHistorianError } from "./types.js";

const scope = { siteId: "11111111-1111-1111-1111-111111111111", stationId: "22222222-2222-2222-2222-222222222222" };
const range = { from: new Date("2026-07-13T06:00:00.000Z"), to: null };
const now = new Date("2026-07-13T12:00:00.000Z").getTime();

describe("historian cursor", () => {
  test("round-trips watermark and range", () => {
    const wm = now - 5_000;
    const token = encodeCursor("stationState", scope, range, wm);
    const decoded = decodeCursor(token, "stationState", scope, now);

    expect(isHistorianError(decoded)).toBe(false);
    if (isHistorianError(decoded)) return;
    expect(decoded.watermarkMs).toBe(wm);
    expect(decoded.range.from.getTime()).toBe(range.from.getTime());
    expect(decoded.range.to).toBeNull();
  });

  test("round-trips a bounded range", () => {
    const bounded = { from: new Date("2026-07-13T06:00:00.000Z"), to: new Date("2026-07-13T14:00:00.000Z") };
    const token = encodeCursor("stationState", scope, bounded, now);
    const decoded = decodeCursor(token, "stationState", scope, now);

    expect(isHistorianError(decoded)).toBe(false);
    if (isHistorianError(decoded)) return;
    expect(decoded.range.to?.getTime()).toBe(bounded.to.getTime());
  });

  test("fingerprint is stable across scope key order", () => {
    const reordered = { stationId: scope.stationId, siteId: scope.siteId };
    expect(cursorFingerprint("stationState", scope, range)).toBe(cursorFingerprint("stationState", reordered, range));
  });

  test("rejects a cursor presented against a different scope", () => {
    const token = encodeCursor("stationState", scope, range, now);
    const otherScope = { ...scope, stationId: "33333333-3333-3333-3333-333333333333" };
    const decoded = decodeCursor(token, "stationState", otherScope, now);

    expect(isHistorianError(decoded)).toBe(true);
    if (isHistorianError(decoded)) expect(decoded.code).toBe("BAD_CURSOR");
  });

  test("rejects a cursor presented against a different series type", () => {
    const token = encodeCursor("stationState", scope, range, now);
    const decoded = decodeCursor(token, "metricBucket", scope, now);

    expect(isHistorianError(decoded)).toBe(true);
  });

  test("rejects an expired cursor", () => {
    const token = encodeCursor("stationState", scope, range, now - CURSOR_TTL_MS - 1);
    const decoded = decodeCursor(token, "stationState", scope, now);

    expect(isHistorianError(decoded)).toBe(true);
    if (isHistorianError(decoded)) expect(decoded.error).toMatch(/expired/i);
  });

  test("rejects garbage tokens", () => {
    expect(isHistorianError(decodeCursor("not-a-cursor", "stationState", scope, now))).toBe(true);
    const truncated = Buffer.from('{"v":1}', "utf8").toString("base64url");
    expect(isHistorianError(decodeCursor(truncated, "stationState", scope, now))).toBe(true);
  });
});

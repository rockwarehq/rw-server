import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "@rw/runtime/events-bus";

vi.mock("@rw/db", () => ({ default: {
  station: { findUnique: async ({ where }: { where: { id: string } }) => where.id === "missing" ? null :
    ({ siteId: where.id === "other-site" ? "other" : "s", workcenterId: where.id === "own" ? "wc-a" : "wc-b" }) },
  point: { findUnique: async () => ({ datasource: { siteId: "other" } }) },
} }));
vi.mock("../src/rpc/middleware.js", () => {
  const builder = { input: () => builder, output: () => builder, handler: (handler: unknown) => handler };
  return { authRequired: builder, processorRequired: builder };
});
import { canReadStreamEvent } from "../src/rpc/events.js";

const scope = { siteId: "s", workspaceId: "w", workcenterIds: ["wc-a"] };
const stationEvent = (stationId: string, workspaceId = "w") => ({
  id: "e", type: "StationEventTriggered", workspaceId, receivedAt: "2026-01-01T00:00:00.000Z",
  payload: { stationId, eventId: "event", executionId: "execution", triggeredAt: "2026-01-01T00:00:00.000Z" },
}) as StreamEvent;

describe("event streams use target ownership, not workspace envelope alone", () => {
  it("suppresses foreign site, foreign WC, missing and foreign-workspace targets", async () => {
    expect(await canReadStreamEvent(stationEvent("own"), scope)).toBe(true);
    for (const id of ["foreign", "other-site", "missing"]) expect(await canReadStreamEvent(stationEvent(id), scope)).toBe(false);
    expect(await canReadStreamEvent(stationEvent("own", "other-workspace"), scope)).toBe(false);
  });
  it("site-wide users remain site-bound and unresolved raw points fail closed", async () => {
    const full = { ...scope, workcenterIds: undefined };
    expect(await canReadStreamEvent(stationEvent("foreign"), full)).toBe(true);
    expect(await canReadStreamEvent(stationEvent("other-site"), full)).toBe(false);
    const point = { ...stationEvent("own"), type: "PointValue", payload: { pointId: "p" } } as StreamEvent;
    expect(await canReadStreamEvent(point, scope)).toBe(false);
    expect(await canReadStreamEvent(point, full)).toBe(false);
  });
});

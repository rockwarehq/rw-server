import { MIRRORED_METRIC_KEYS } from "@rw/runtime/graph-subjects";
import { describe, expect, it } from "vitest";

import type { MetricChangeEvent } from "../rpc/metrics-bus.js";
import { metricChangeToGraphPublishes } from "./graph-nats-bridge.js";

const change = (overrides: Partial<MetricChangeEvent> = {}): MetricChangeEvent => ({
  siteId: "site-1",
  entityType: "STATION",
  entityId: "stn-25",
  entityName: "STN-25",
  path: "",
  granularity: "SHIFT",
  granularityName: "Shift 1",
  startTime: new Date(0),
  durationSeconds: 0,
  shiftInstanceId: null,
  businessDate: null,
  businessShift: null,
  snapshot: { goodItems: 42 } as unknown as MetricChangeEvent["snapshot"],
  ...overrides,
});

describe("metricChangeToGraphPublishes", () => {
  it("expands a STATION SHIFT change into one publish per mirrored key", () => {
    const publishes = metricChangeToGraphPublishes(change(), 1000);
    expect(publishes).toContainEqual({
      subject: "metrics.stn-25.SHIFT.goodItems",
      envelope: { value: 42, quality: "good", timestamp: 1000 },
    });
    // Every other mirrored key is absent from the snapshot, so it publishes stale.
    for (const p of publishes.filter((p) => !p.subject.endsWith(".goodItems"))) {
      expect(p.envelope).toEqual({ value: null, quality: "stale", timestamp: 1000 });
    }
    expect(publishes).toHaveLength(MIRRORED_METRIC_KEYS.length);
  });

  it("emits a stale envelope when the snapshot value is missing", () => {
    const snapshot = {} as unknown as MetricChangeEvent["snapshot"];
    expect(metricChangeToGraphPublishes(change({ snapshot }), 1000)[0]?.envelope).toEqual({
      value: null,
      quality: "stale",
      timestamp: 1000,
    });
  });

  it("ignores non-STATION entities (graph rolls those up itself)", () => {
    expect(metricChangeToGraphPublishes(change({ entityType: "WORKCENTER" }), 1000)).toEqual([]);
  });

  it("ignores non-SHIFT granularity", () => {
    expect(metricChangeToGraphPublishes(change({ granularity: "HOUR" }), 1000)).toEqual([]);
  });
});

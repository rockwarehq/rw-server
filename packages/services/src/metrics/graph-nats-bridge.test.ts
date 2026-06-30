import { MIRRORED_CONTEXT_KEYS, MIRRORED_METRIC_KEYS } from "@rw/runtime/graph-subjects";
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
  it("expands a STATION SHIFT change into one publish per mirrored metric + context key", () => {
    const publishes = metricChangeToGraphPublishes(change(), 1000);
    expect(publishes).toContainEqual({
      subject: "metrics.stn-25.SHIFT.goodItems",
      envelope: { value: 42, quality: "good", timestamp: 1000 },
    });
    expect(publishes).toHaveLength(MIRRORED_METRIC_KEYS.length + MIRRORED_CONTEXT_KEYS.length);
  });

  it("emits a stale envelope when the snapshot value is missing", () => {
    const snapshot = {} as unknown as MetricChangeEvent["snapshot"];
    const publishes = metricChangeToGraphPublishes(change({ snapshot }), 1000);
    expect(publishes.find((p) => p.subject === "metrics.stn-25.SHIFT.goodItems")?.envelope).toEqual({
      value: null,
      quality: "stale",
      timestamp: 1000,
    });
  });

  it("mirrors context columns from the snapshot and startTime from the change", () => {
    const snapshot = {
      goodItems: 42,
      businessShift: "Shift 1",
      businessDate: "2026-06-30",
      currentJobName: "Job A",
      currentStandardCycle: 12.5,
    } as unknown as MetricChangeEvent["snapshot"];
    const publishes = metricChangeToGraphPublishes(change({ snapshot, startTime: new Date(1000) }), 1000);
    const envelopeFor = (key: string) => publishes.find((p) => p.subject === `metrics.stn-25.SHIFT.${key}`)?.envelope;

    expect(envelopeFor("businessShift")).toEqual({ value: "Shift 1", quality: "good", timestamp: 1000 });
    expect(envelopeFor("businessDate")).toEqual({ value: "2026-06-30", quality: "good", timestamp: 1000 });
    expect(envelopeFor("currentJobName")).toEqual({ value: "Job A", quality: "good", timestamp: 1000 });
    expect(envelopeFor("currentStandardCycle")).toEqual({ value: 12.5, quality: "good", timestamp: 1000 });
    expect(envelopeFor("startTime")).toEqual({
      value: "1970-01-01T00:00:01.000Z",
      quality: "good",
      timestamp: 1000,
    });
  });

  it("emits stale context envelopes when columns are null", () => {
    const publishes = metricChangeToGraphPublishes(change({ startTime: null as unknown as Date }), 1000);
    const envelopeFor = (key: string) => publishes.find((p) => p.subject === `metrics.stn-25.SHIFT.${key}`)?.envelope;
    expect(envelopeFor("businessShift")).toEqual({ value: null, quality: "stale", timestamp: 1000 });
    expect(envelopeFor("startTime")).toEqual({ value: null, quality: "stale", timestamp: 1000 });
  });

  it("ignores non-STATION entities (graph rolls those up itself)", () => {
    expect(metricChangeToGraphPublishes(change({ entityType: "WORKCENTER" }), 1000)).toEqual([]);
  });

  it("ignores non-SHIFT granularity", () => {
    expect(metricChangeToGraphPublishes(change({ granularity: "HOUR" }), 1000)).toEqual([]);
  });
});

import {
  deriveDeviceHealthSubjectFilter,
  deriveGatewayHealthSubject,
  parseDeviceHealthSubject,
} from "@rw/runtime/gateway-subjects";
import { describe, expect, it } from "vitest";
import { toHealthEvent } from "../src/nats/health-stream.js";

// RW_HEALTH messages -> gateway.health events. No NATS; the subject contract
// mirrors rw-gateway src/subjects.ts.
const GW = "7a1d3c52-9e0b-4c1f-8f5e-2b6a9d0e4c11";
const DS = "c0ffee00-1234-4abc-9def-000000000001";
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("health subjects", () => {
  it("filters every driver on one gateway", () => {
    expect(deriveGatewayHealthSubject(GW)).toBe(`health.gateway.${GW}`);
    expect(deriveDeviceHealthSubjectFilter(GW)).toBe(`health.device.${GW}.*`);
  });

  it("parses only the 4-token device subject", () => {
    expect(parseDeviceHealthSubject(`health.device.${GW}.${DS}`)).toEqual({ gatewayId: GW, datasourceId: DS });
    expect(parseDeviceHealthSubject(`health.gateway.${GW}`)).toBeNull();
    expect(parseDeviceHealthSubject(`health.device.${GW}`)).toBeNull();
    expect(parseDeviceHealthSubject(`tags.${GW}.${DS}`)).toBeNull();
  });
});

describe("toHealthEvent", () => {
  it("maps a gateway snapshot with its age", () => {
    const event = toHealthEvent(`health.gateway.${GW}`, encode({ status: "up", version: "1.2.3" }), 1_000, 4_500);
    expect(event).toEqual({ kind: "gateway", ageMs: 3_500, snapshot: { status: "up", version: "1.2.3" } });
  });

  it("maps a device snapshot to its datasource", () => {
    const event = toHealthEvent(`health.device.${GW}.${DS}`, encode({ connected: false, badTagCount: 12 }), 2_000, 2_000);
    expect(event).toEqual({
      kind: "device",
      datasourceId: DS,
      ageMs: 0,
      snapshot: { connected: false, badTagCount: 12 },
    });
  });

  it("never reports a negative age", () => {
    expect(toHealthEvent(`health.gateway.${GW}`, encode({}), 5_000, 4_000)?.ageMs).toBe(0);
  });

  it("drops malformed payloads and foreign subjects", () => {
    expect(toHealthEvent(`health.gateway.${GW}`, new TextEncoder().encode("{not json"), 0, 0)).toBeNull();
    expect(toHealthEvent(`health.gateway.${GW}`, encode(42), 0, 0)).toBeNull();
    expect(toHealthEvent(`health.other.${GW}`, encode({}), 0, 0)).toBeNull();
  });
});

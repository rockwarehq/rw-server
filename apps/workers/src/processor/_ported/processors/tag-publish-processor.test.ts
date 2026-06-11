import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ParsedEvent } from "../pipeline/types.js";
import { createTagPublishProcessor } from "./tag-publish-processor.js";

const decoder = new TextDecoder();

function createPointEvent(overrides: Record<string, unknown> = {}): ParsedEvent {
  const now = Date.now();
  return {
    id: "event-1:point:0",
    topic: "/Rockware/v1/Gateway/gw-1/Device/device-1/Points",
    metadata: {
      family: "rockware",
      version: "1",
      gatewayId: "gw-1",
      deviceId: "device-1",
      resource: "Points",
      scope: "device",
    },
    receivedAt: now,
    parsedAt: now,
    payload: {
      point: {
        id: "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0",
        name: "01CNT04",
        value: 497,
        valueRaw: 4960,
        quality: "GOOD",
        timestamp: 1770651932996,
        gatewayTimestamp: 1770651933000,
        pointValueId: "0194c0de-0000-7000-8000-000000000000",
        datasourceId: "ds-1",
        ...overrides,
      },
    },
    raw: Buffer.from("{}", "utf8"),
  };
}

const testLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function createCapture() {
  const published: Array<{ subject: string; envelope: Record<string, unknown> }> = [];
  return {
    published,
    publisher: {
      publish(subject: string, data: Uint8Array) {
        published.push({ subject, envelope: JSON.parse(decoder.decode(data)) });
      },
    },
  };
}

describe("createTagPublishProcessor", () => {
  test("publishes a ValueEnvelope on the point's tag subject", async () => {
    const { published, publisher } = createCapture();
    const processor = createTagPublishProcessor({ publisher, logger: testLogger });

    const event = createPointEvent();
    assert.equal(processor.matches(event), true);
    await processor.process(event, undefined as never);

    assert.equal(published.length, 1);
    assert.equal(published[0]?.subject, "tags.ds-1.9da3d1c3-7c6d-4d2c-82a9-4c76196222d0");
    assert.deepEqual(published[0]?.envelope, {
      value: 497,
      quality: "good",
      timestamp: 1770651932996,
      context: { valueRaw: 4960 },
    });
  });

  test("maps point quality to envelope quality", async () => {
    const cases: Array<[string, string]> = [
      ["GOOD", "good"],
      ["BAD", "bad"],
      ["UNKNOWN", "uncertain"],
      ["GARBAGE", "uncertain"],
    ];

    for (const [pointQuality, envelopeQuality] of cases) {
      const { published, publisher } = createCapture();
      const processor = createTagPublishProcessor({ publisher, logger: testLogger });
      await processor.process(createPointEvent({ quality: pointQuality }), undefined as never);
      assert.equal(published[0]?.envelope.quality, envelopeQuality, pointQuality);
    }
  });

  test("skips points missing datasourceId, value, or timestamp", async () => {
    const { published, publisher } = createCapture();
    const processor = createTagPublishProcessor({ publisher, logger: testLogger });

    await processor.process(createPointEvent({ datasourceId: undefined }), undefined as never);
    await processor.process(createPointEvent({ value: undefined }), undefined as never);
    await processor.process(createPointEvent({ timestamp: "not-a-date" }), undefined as never);

    assert.equal(published.length, 0);
  });

  test("does not match non-points events", () => {
    const { publisher } = createCapture();
    const processor = createTagPublishProcessor({ publisher, logger: testLogger });

    const event = createPointEvent();
    event.metadata = { ...(event.metadata as object), resource: "Health" } as ParsedEvent["metadata"];
    assert.equal(processor.matches(event), false);
  });
});

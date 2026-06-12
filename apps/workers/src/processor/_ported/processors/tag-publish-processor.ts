import { deriveTagSubject } from "@rw/runtime/graph-subjects";

import type { ParsedEvent, Processor, ProcessorContext } from "../pipeline/types.js";

export interface TagPublisher {
  publish(subject: string, data: Uint8Array): void;
}

type TagQuality = "good" | "uncertain" | "bad";

const QUALITY_MAP: Record<string, TagQuality> = { GOOD: "good", BAD: "bad", UNKNOWN: "uncertain" };

const encoder = new TextEncoder();

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (value instanceof Date || typeof value === "string") {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}

// Publishes point values as ValueEnvelopes on tags.<datasourceId>.<pointId> for the
// graph engine. Handles both event shapes: enriched per-point events (payload.point,
// calibrated, datasourceId attached) and raw gateway batches (payload.points, value
// as received). The gateway publishes each batch on Device/<datasourceId>/Points, so
// for raw points the topic's deviceId IS the datasourceId — no lookup needed.
export function createTagPublishProcessor(args: {
  publisher: TagPublisher;
  logger: ProcessorContext["logger"];
}): Processor {
  function publishPoint(event: ParsedEvent, point: Record<string, unknown>): void {
    const pointId = typeof point.id === "string" ? point.id : undefined;
    const timestamp = toEpochMs(point.timestamp);
    const datasourceId =
      typeof point.datasourceId === "string" ? point.datasourceId : event.metadata?.deviceId;

    if (!pointId || !datasourceId || point.value === undefined || timestamp === undefined) {
      args.logger.debug("skipping tag publish", {
        processor: "tag-publish",
        eventId: event.id,
        pointId,
        hasDatasourceId: datasourceId !== undefined,
      });
      return;
    }

    const envelope = {
      value: point.value,
      quality: QUALITY_MAP[String(point.quality)] ?? "uncertain",
      timestamp,
      ...(point.valueRaw !== undefined && { context: { valueRaw: point.valueRaw } }),
    };

    args.publisher.publish(deriveTagSubject(datasourceId, pointId), encoder.encode(JSON.stringify(envelope)));
  }

  return {
    name: "tag-publish",
    matches: (event: ParsedEvent) => event.metadata?.resource === "Points",
    async process(event: ParsedEvent): Promise<void> {
      if (!isJsonObject(event.payload)) {
        return;
      }

      const single = event.payload.point;
      if (isJsonObject(single)) {
        publishPoint(event, single);
        return;
      }

      const batch = event.payload.points;
      if (!Array.isArray(batch)) {
        return;
      }
      for (const candidate of batch) {
        if (isJsonObject(candidate)) {
          publishPoint(event, candidate);
        }
      }
    },
  };
}

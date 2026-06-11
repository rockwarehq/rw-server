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

// Publishes enriched point values as ValueEnvelopes on tags.<datasourceId>.<pointId> for the graph engine.
export function createTagPublishProcessor(args: {
  publisher: TagPublisher;
  logger: ProcessorContext["logger"];
}): Processor {
  return {
    name: "tag-publish",
    matches: (event: ParsedEvent) => event.metadata?.resource === "Points",
    async process(event: ParsedEvent): Promise<void> {
      const point = isJsonObject(event.payload) ? event.payload.point : undefined;
      if (!isJsonObject(point)) {
        return;
      }

      const pointId = typeof point.id === "string" ? point.id : undefined;
      const datasourceId = typeof point.datasourceId === "string" ? point.datasourceId : undefined;
      const timestamp = toEpochMs(point.timestamp);

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
        context: { valueRaw: point.valueRaw },
      };

      args.publisher.publish(deriveTagSubject(datasourceId, pointId), encoder.encode(JSON.stringify(envelope)));
    },
  };
}

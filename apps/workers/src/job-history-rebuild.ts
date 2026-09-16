// Rebuilds metric buckets after a job history amendment. Lives in the rollups
// worker: it needs the direct DB URL and must not race the bucket pipeline.

import {
  JOB_HISTORY_EVENT_STREAM,
  JOB_HISTORY_EVENT_SUBJECT_FILTER,
  parseJobHistoryAmendedEvent,
} from "@rw/runtime/job-history-events";
import { rebuildForAmendment } from "@rw/services/history/index";
import { createDomainEventConsumer } from "./domain-event-consumer.js";

const consumer = createDomainEventConsumer({
  name: "job-history-rebuild",
  stream: JOB_HISTORY_EVENT_STREAM,
  subjects: JOB_HISTORY_EVENT_SUBJECT_FILTER,
  parse: parseJobHistoryAmendedEvent,
  handle: async (event) => {
    await rebuildForAmendment(event.amendmentId, event.displacedJobIds);
    console.log(`[job-history-rebuild] rebuilt amendment ${event.amendmentId} station=${event.stationId}`);
  },
});

export const startJobHistoryRebuild = consumer.start;
export const stopJobHistoryRebuild = consumer.stop;

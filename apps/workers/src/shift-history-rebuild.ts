// Rebuilds metric buckets after a shift amendment (ADR-0015). Lives in the
// rollups worker beside the job-history rebuild for the same reasons. How the
// rebuild ended reaches the UI from the service, through publishUiChange.

import {
  parseShiftHistoryEvent,
  SHIFT_HISTORY_EVENT_STREAM,
  SHIFT_HISTORY_EVENT_SUBJECT_FILTER,
} from "@rw/runtime/shift-history-events";
import { shift } from "@rw/services/facility/index";
import { createDomainEventConsumer } from "./domain-event-consumer.js";

const consumer = createDomainEventConsumer({
  name: "shift-history-rebuild",
  stream: SHIFT_HISTORY_EVENT_STREAM,
  subjects: SHIFT_HISTORY_EVENT_SUBJECT_FILTER,
  parse: parseShiftHistoryEvent,
  handle: (event) => shift.amend.rebuildForShiftAmendment(event.amendmentId),
});

export const startShiftHistoryRebuild = consumer.start;
export const stopShiftHistoryRebuild = consumer.stop;

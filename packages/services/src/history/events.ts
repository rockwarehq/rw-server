import type { JobHistoryAmendedEvent } from "@rw/runtime/job-history-events";
import { createEventSink, type EventSink } from "../events/sink.js";

const jobHistoryEvents = createEventSink<JobHistoryAmendedEvent>("job-history-events");

export type JobHistoryEventSink = EventSink<JobHistoryAmendedEvent>;
export const setJobHistoryEventSink = jobHistoryEvents.set;
export const publishJobHistoryEvent = jobHistoryEvents.publish;

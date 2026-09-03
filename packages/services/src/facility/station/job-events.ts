import type { JobEvent } from "@rw/runtime/job-events";
import { createEventSink, type EventSink } from "../../events/sink.js";

const jobEvents = createEventSink<JobEvent>("job-events");

export type JobEventSink = EventSink<JobEvent>;
export const setJobEventSink = jobEvents.set;
export const publishJobEvent = jobEvents.publish;

import type { CallEvent } from "@rw/runtime/call-events";
import { createEventSink, type EventSink } from "../../events/sink.js";

const callEvents = createEventSink<CallEvent>("call-events");

export type CallEventSink = EventSink<CallEvent>;
export const setCallEventSink = callEvents.set;
export const publishCallEvent = callEvents.publish;

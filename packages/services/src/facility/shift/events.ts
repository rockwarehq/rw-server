import type { ShiftHistoryEvent } from "@rw/runtime/shift-history-events";
import { createEventSink, type EventSink } from "../../events/sink.js";

const shiftHistoryEvents = createEventSink<ShiftHistoryEvent>("shift-history-events");

export type ShiftHistoryEventSink = EventSink<ShiftHistoryEvent>;
export const setShiftHistoryEventSink = shiftHistoryEvents.set;
export const publishShiftHistoryEvent = shiftHistoryEvents.publish;

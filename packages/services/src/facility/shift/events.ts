import type { ShiftHistoryEvent } from "@rw/runtime/shift-history-events";
import { createEventSink } from "../../events/sink.js";

const shiftHistoryEvents = createEventSink<ShiftHistoryEvent>("shift-history-events");

export const setShiftHistoryEventSink = shiftHistoryEvents.set;
export const publishShiftHistoryEvent = shiftHistoryEvents.publish;

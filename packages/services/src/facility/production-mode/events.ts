import type { ModeEvent } from "@rw/runtime/mode-events";
import { createEventSink, type EventSink } from "../../events/sink.js";

const modeEvents = createEventSink<ModeEvent>("mode-events");

export type ModeEventSink = EventSink<ModeEvent>;
export const setModeEventSink = modeEvents.set;
export const publishModeEvent = modeEvents.publish;

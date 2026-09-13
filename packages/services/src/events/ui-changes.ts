import type { UiChangeEvent } from "@rw/runtime/ui-change-events";
import { createEventSink } from "./sink.js";

/** "Something changed" pings for browsers (see @rw/runtime/ui-change-events); the app installs the NATS sink. */
const uiChanges = createEventSink<UiChangeEvent>("ui-changes");
export const setUiChangeSink = uiChanges.set;
export const publishUiChange = uiChanges.publish;

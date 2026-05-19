import { getAction, hasAction, listActions, registerAction, validateActionInput } from "./catalog.js";
import { alertCreateAction } from "./alertcreate.js";
import { cycleRecordAction } from "./cyclerecord.js";
import { jobChangeAction } from "./jobchange.js";
import { logEventAction } from "./logevent.js";
import { webhookSendAction } from "./webhooksend.js";
import type { StationActionDefinition } from "./types.js";

function registerBuiltInAction<TInput>(action: StationActionDefinition<TInput>) {
  if (!hasAction(action.key)) {
    registerAction(action);
  }
}

registerBuiltInAction(cycleRecordAction);
registerBuiltInAction(jobChangeAction);
registerBuiltInAction(alertCreateAction);
registerBuiltInAction(logEventAction);
registerBuiltInAction(webhookSendAction);

export { getAction, hasAction, listActions, registerAction, validateActionInput };
export type {
  StationActionDefinition,
  StationActionExecutionContext,
  StationActionValidationError,
  StationActionValidationResult,
} from "./types.js";

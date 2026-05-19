// Station service - public API
// Re-exports all station-related functionality

export * as crud from "./crud.js";
export * as events from "./events.js";
export * as state from "./state.js";
export * as stateDetection from "./state-detection.js";
export * as actions from "./actions/index.js";
export * as execution from "./execution.js";
export * as jobs from "./jobs.js";

// Re-export commonly used functions at top level for convenience
export {
  create,
  list,
  getById,
  update,
  move,
  remove,
  exists,
  addDatasource,
  removeDatasource,
  listDatasources,
  type CreateStationInput,
  type UpdateStationInput,
  type ListStationsFilter,
} from "./crud.js";

export {
  create as createEvent,
  list as listEvents,
  listExecutions as listEventExecutions,
  listForProcessor as listEventsForProcessor,
  getTagSnapshotsForProcessor,
  update as updateEvent,
  remove as removeEvent,
  toggle as toggleEvent,
  trigger as triggerEvent,
  type CreateStationEventInput,
  type ListStationEventExecutionsOptions,
  type StationEventExecutionActionResult,
  type StationEventExecutionListItem,
  type ProcessorTagSnapshot,
  type TriggerStationEventInput,
  type UpdateStationEventInput,
} from "./events.js";

export {
  transitionToUp,
  transitionToSlow,
  transitionToDown,
  splitDownEntry,
  assignDowntimeReason,
  listStateLogs,
  type ListStateLogsFilter,
} from "./state.js";

export {
  scheduleDetection,
  cancelDetection,
} from "./state-detection.js";

export { changeJob } from "./jobs.js";

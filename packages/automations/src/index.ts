// @rw/automations — a domain-agnostic event → condition → action engine.
//
// The consuming app supplies its domain (event/action schemas, fact builders, action handlers, and
// a store) and calls `createAutomationFramework(config)`.

export {
  type ActionContext,
  type ActionHandler,
  type ActionRegistry,
  type ActionVersion,
  createActionRegistry,
} from "./actions.js";
export { type ContextBuilder, statelessContextBuilder } from "./context.js";
export { type CooldownStore, createMemoryCooldownStore } from "./cooldown.js";
export type { AutomationEngine, DispatchResult } from "./engine.js";
export {
  causeOf,
  createAutomationFramework,
  DEFAULT_MAX_HOPS,
  type FireOptions,
  type FireResult,
  type AutomationFramework,
  type AutomationFrameworkConfig,
} from "./framework.js";
export type { RuleGroupType, RuleType } from "./query-builder-types.js";
export type {
  FinishRunInput,
  RecordActionInput,
  RunRecorder,
  StartRunInput,
} from "./recorder.js";
export {
  createRefRegistry,
  type RefContext,
  type RefOption,
  type RefRegistry,
  type RefSource,
} from "./refs.js";
export type { AutomationStore } from "./store.js";
export type {
  ActionInputSchema,
  ActionSchema,
  ActionSchemaVersion,
  AppEvent,
  Catalog,
  EventCause,
  EventSchema,
  EventSchemaVersion,
  EventType,
  FactDef,
  FactMap,
  RefAnnotation,
  SchemaProperty,
  TemplateVariable,
  Automation,
  AutomationAction,
} from "./types.js";

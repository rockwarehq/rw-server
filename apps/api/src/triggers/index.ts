import { createRefRegistry, createTriggerFramework, type TriggerFramework, type TriggerStore } from "@rw/triggers";
import { ACTION_SCHEMAS, buildActionRegistry } from "./actions/index.js";
import { buildContextBuilders, EVENT_SCHEMAS } from "./events/index.js";
import { usersRefSource } from "./refs.js";
import { createFileTriggerStore } from "./store.js";

export interface CreateAppTriggerFrameworkOptions {
  store?: TriggerStore;
}

export function createAppTriggerFramework(opts: CreateAppTriggerFrameworkOptions = {}): TriggerFramework {
  return createTriggerFramework({
    eventSchemas: EVENT_SCHEMAS,
    actionSchemas: ACTION_SCHEMAS,
    store: opts.store ?? createFileTriggerStore(),
    contextBuilders: buildContextBuilders(),
    actions: buildActionRegistry(),
    // Picker data sources for ref-typed action inputs. Add more sources here as actions grow
    refs: createRefRegistry().register(usersRefSource),
  });
}

let singleton: TriggerFramework | undefined;

/** Lazily-created shared framework instance (mock store). Used by the oRPC layer. */
export function getTriggerFramework(): TriggerFramework {
  if (!singleton) singleton = createAppTriggerFramework();
  return singleton;
}

export type {
  AppEvent,
  Catalog,
  EventType,
  Trigger,
  TriggerAction,
  TriggerFramework,
  TriggerStore,
} from "@rw/triggers";

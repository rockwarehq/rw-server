import {
  createRefRegistry,
  createAutomationFramework,
  type AutomationFramework,
  type AutomationStore,
} from "@rw/automations";
import { ACTION_SCHEMAS, buildActionRegistry } from "./actions/index.js";
import { buildContextBuilders, EVENT_SCHEMAS } from "./events/index.js";
import { usersRefSource } from "./refs.js";
import { createFileAutomationStore } from "./store.js";

export interface CreateAppAutomationFrameworkOptions {
  store?: AutomationStore;
}

export function createAppAutomationFramework(opts: CreateAppAutomationFrameworkOptions = {}): AutomationFramework {
  return createAutomationFramework({
    eventSchemas: EVENT_SCHEMAS,
    actionSchemas: ACTION_SCHEMAS,
    store: opts.store ?? createFileAutomationStore(),
    contextBuilders: buildContextBuilders(),
    actions: buildActionRegistry(),
    // Picker data sources for ref-typed action inputs. Add more sources here as actions grow
    refs: createRefRegistry().register(usersRefSource),
  });
}

let singleton: AutomationFramework | undefined;

/** Lazily-created shared framework instance (mock store). Used by the oRPC layer. */
export function getAutomationFramework(): AutomationFramework {
  if (!singleton) singleton = createAppAutomationFramework();
  return singleton;
}

export type {
  AppEvent,
  Catalog,
  EventType,
  Automation,
  AutomationAction,
  AutomationFramework,
  AutomationStore,
} from "@rw/automations";

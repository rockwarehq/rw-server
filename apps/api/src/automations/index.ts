import { type AutomationFramework, createAutomationFramework, createRefRegistry } from "@rw/automations";
import { createDbCooldownStore } from "@rw/services/automation/cooldown-store";
import { createDbRunRecorder } from "@rw/services/automation/recorder";
import { createDbAutomationStore } from "@rw/services/automation/store";
import { callDefinitionsAutomationRef } from "@rw/services/facility/call/automation-ref";
import { productionModesAutomationRef } from "@rw/services/facility/production-mode/automation-ref";
import { stationsAutomationRef } from "@rw/services/facility/station/automation-ref";
import { shiftNamesAutomationRef } from "@rw/services/facility/work-context";
import { employeesAutomationRef, notificationGroupsAutomationRef } from "@rw/services/notification/automation-ref";
import { workCentersAutomationRef } from "@rw/services/facility/workcenter/automation-ref";
import { jobsAutomationRef } from "@rw/services/job/automation-ref";
import { createNatsScheduleStore } from "../nats/automation-schedule-store.js";
import { ACTION_SCHEMAS, buildActionRegistry } from "./actions/index.js";
import { buildContextBuilders, EVENT_SCHEMAS } from "./events/index.js";

/**
 * Build the DB-backed automation framework wired with this app's events + actions + refs.
 * Automations are partitioned by site: every event carries `siteId`, and an automation only sees
 * its own site's events. Wires:
 *   - `createDbAutomationStore` — automation definitions in Postgres.
 *   - the audit recorder — writes `AutomationRun` + `AutomationActionRun` rows on every fire.
 *   - the cooldown store — shared last-fired times.
 *   - the NATS schedule store — armed delayed actions as JetStream scheduled messages. NATS is
 *     required; building the framework throws without it.
 *   - the DB-backed ref sources — pickers list every user / job / station / work center.
 */
export async function createAppAutomationFramework(): Promise<AutomationFramework> {
  const store = await createDbAutomationStore();
  const refs = createRefRegistry()
    .register(workCentersAutomationRef)
    .register(stationsAutomationRef)
    .register(jobsAutomationRef)
    .register(callDefinitionsAutomationRef)
    .register(productionModesAutomationRef)
    .register(notificationGroupsAutomationRef)
    .register(employeesAutomationRef)
    .register(shiftNamesAutomationRef);

  return createAutomationFramework({
    eventSchemas: EVENT_SCHEMAS,
    actionSchemas: ACTION_SCHEMAS,
    store,
    contextBuilders: buildContextBuilders(),
    actions: buildActionRegistry(),
    refs,
    recorder: createDbRunRecorder(),
    partitionField: "siteId",
    maxHops: 5,
    cooldowns: createDbCooldownStore(),
    schedules: await createNatsScheduleStore(),
  });
}

// Single shared framework. Concurrent first calls share one creation promise so the initial Prisma
// load runs at most once, even under burst traffic at boot.
let cached: AutomationFramework | undefined;
let pending: Promise<AutomationFramework> | undefined;

/**
 * Resolve the shared `AutomationFramework`. First call builds + caches; subsequent calls return the
 * same instance.
 */
export async function getAutomationFramework(): Promise<AutomationFramework> {
  if (cached) return cached;
  if (pending) return pending;

  pending = (async () => {
    const fw = await createAppAutomationFramework();
    cached = fw;
    pending = undefined;
    return fw;
  })();
  return pending;
}

export type {
  AppEvent,
  Automation,
  AutomationAction,
  AutomationFramework,
  AutomationStore,
  Catalog,
  EventType,
} from "@rw/automations";

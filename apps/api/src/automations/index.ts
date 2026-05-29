import { type AutomationFramework, createAutomationFramework, createRefRegistry } from "@rw/automations";
import { createDbRunRecorder } from "@rw/services/automation/recorder";
import { createDbAutomationStore } from "@rw/services/automation/store";
import { createEmployeesAutomationRef } from "@rw/services/employee/automation-ref";
import { createStationsAutomationRef } from "@rw/services/facility/station/automation-ref";
import { createWorkcentersAutomationRef } from "@rw/services/facility/workcenter/automation-ref";
import { createJobsAutomationRef } from "@rw/services/job/automation-ref";
import { ACTION_SCHEMAS, buildActionRegistry } from "./actions/index.js";
import { buildContextBuilders, EVENT_SCHEMAS } from "./events/index.js";

/**
 * Build a DB-backed automation framework wired with this app's events + actions + refs for one
 * workspace. Wires:
 *   - `createDbAutomationStore` — automation definitions in Postgres.
 *   - the audit recorder — writes `AutomationRun` + `AutomationActionRun` rows on every fire.
 *   - the DB-backed ref sources — pickers list the workspace's employees / jobs / stations /
 *     work centers.
 */
export async function createAppAutomationFramework(workspaceId: string): Promise<AutomationFramework> {
  const store = await createDbAutomationStore(workspaceId);
  const refs = createRefRegistry()
    .register(createEmployeesAutomationRef(workspaceId))
    .register(createWorkcentersAutomationRef(workspaceId))
    .register(createStationsAutomationRef(workspaceId))
    .register(createJobsAutomationRef(workspaceId));

  return createAutomationFramework({
    eventSchemas: EVENT_SCHEMAS,
    actionSchemas: ACTION_SCHEMAS,
    store,
    contextBuilders: buildContextBuilders(),
    actions: buildActionRegistry(),
    refs,
    recorder: createDbRunRecorder(workspaceId),
  });
}

// Per-workspace framework cache. Concurrent first calls share one creation promise so the initial
// Prisma load runs at most once per workspace, even under burst traffic at boot.
const cache = new Map<string, AutomationFramework>();
const pending = new Map<string, Promise<AutomationFramework>>();

/**
 * Resolve the shared `AutomationFramework` for a workspace. First call builds + caches; subsequent
 * calls return the same instance. The oRPC layer calls this with `context.iam.workspaceId`.
 */
export async function getAutomationFramework(workspaceId: string): Promise<AutomationFramework> {
  const cached = cache.get(workspaceId);
  if (cached) return cached;
  const inflight = pending.get(workspaceId);
  if (inflight) return inflight;

  const promise = (async () => {
    const fw = await createAppAutomationFramework(workspaceId);
    cache.set(workspaceId, fw);
    pending.delete(workspaceId);
    return fw;
  })();
  pending.set(workspaceId, promise);
  return promise;
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

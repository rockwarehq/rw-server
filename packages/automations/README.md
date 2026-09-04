# @rw/automations

A small, domain-agnostic, event-driven automation engine: an **event** comes in, its **conditions**
are evaluated, and if they match, its **actions** run — sequentially, in one pass. Just-in-time and
in-process: no queue, no worker.

This package is the reusable **engine** only — no concrete event/action types. The consuming app
supplies its domain (schemas, fact builders, handlers, a store) and calls
`createAutomationFramework(config)`. Everything that varies is reached through a **seam** (an
interface swapped from outside the engine), so adding behavior never edits the engine.

## Consuming it

```ts
import { createAutomationFramework } from "@rw/automations";

const fw = createAutomationFramework({
  eventSchemas: EVENT_SCHEMAS,    // your domain
  actionSchemas: ACTION_SCHEMAS,  // your domain
  store,                          // your AutomationStore impl
  contextBuilders,                // Record<eventType, ContextBuilder> — must cover every event schema
  actions,                        // ActionRegistry of your handlers
  // refs, recorder, partitionField, maxHops — optional
});
```

The returned framework exposes `store`, `engine`, `catalog()`, `validateActionInputs()`,
`listRefOptions()`, and `fire()`. For a concrete consumer, see
[`apps/api/src/automations`](../../apps/api/src/automations/README.md).

## The seams

| Seam | Interface | What you swap |
| --- | --- | --- |
| event → facts | `ContextBuilder` | how an event becomes the fact map conditions read |
| what an action does | `ActionHandler` / `ActionRegistry` | the effect a matched automation runs |
| definition storage | `AutomationStore` | where automation definitions live |
| ref pickers | `RefSource` / `RefRegistry` | picker data for ref-typed action inputs |

## Raising an event

```ts
const { eventId, matched } = await fw.fire("job.changed", { previousJobId: "j_100", currentJobId: "j_200", stationId: "s_1" });
// matched → ids of automations whose conditions matched
```

`fire()` validates the payload, builds the event (`id` + `ts`, stamps `version`), dispatches it, and
runs every action of every matched automation in order. It **throws** on a bad payload, unknown
event type/version, or a misconfigured matched action (missing handler / missing required input) —
side effects of actions that already ran do not roll back. The one non-error empty case: an event
type with no automations returns `{ eventId, matched: [] }`.

Pass `{ version }` to raise a specific event version; defaults to the schema's `latest`.

## Partitions

A multi-tenant consumer sets `partitionField` (e.g. `"siteId"`). Every event schema version must then
declare that payload field; `fire()` copies its value to `event.partition`. An `Automation` with a
`partition` only sees events of its own partition; one with `partition: null` is global and sees
them all. The package never knows what a partition *is* — the app maps it to a site, tenant, etc.

## Chains and hops

Every event carries `correlationId` (the root event of its chain), `causationId` (the event that
directly caused it) and `hop` (how many automation-fired events deep it is). A root event has
`correlationId === id` and `hop 0`. When an action triggers something that raises another event,
pass `causeOf(ctx.event)` through to that `fire()` call as `{ cause }` and the chain continues.
An event whose `hop` exceeds `maxHops` (default 5) is not evaluated: `fire()` returns `dropped` and
the recorder gets a `DROPPED` run, so a loop stops and is visible in the audit.

## Cooldown

An `Automation` with `cooldownMs` fires at most once per cooldown scope per window. The scope is the
event's `cooldownKey` payload field (defaulting to `scopeKey`; absent = one scope per automation), so
"notify when a call opens" can cool down per station while calls themselves are scoped by call id.
Matches inside the window are reported as `cooled` (and recorded as skipped matches), not run. The
last-fired times live in the `CooldownStore` seam; the default is in-memory, the app supplies a shared
store so several instances agree.

## Scope key

An event schema version may name a `scopeKey` — the payload field saying what the event is about
(`"callId"`, `"stationId"`). `fire()` copies it to `event.scope`. Delayed actions are armed and
cancelled per scope value.

## Delayed actions

An action with `delayMs` is armed instead of run when its automation matches: the engine hands
`(automation, action index, scope, runAt, event)` to the `ScheduleStore` and records the action as
`SCHEDULED` (or `SKIPPED` when the key was already taken). Arming is if-absent, so a repeat match
for the same scope keeps the original clock. When a later event of the same type for the same scope
does *not* match the automation, its armed actions for that scope are cancelled — "notify if still
down after 10 minutes" clears itself when the station comes back up. After a fire the key stays held
until such a clearing event, so the action runs once per incident; set `repeat` on the action to
re-arm on the scope's next match instead. `engine.startScheduled()` subscribes to the store; each due entry runs
against the automation as it is now (a disabled automation or removed action is dropped) and is
recorded as its own run carrying the original event. The default store is in-process timers; the
app supplies a shared one so several instances see one pending set and each entry runs on exactly
one of them. `runAt` is the event time plus the delay; anchoring it elsewhere (a "down since" field)
is a one-line change in `runActions`.

## Versioning

Schemas and handlers carry a `latest` pointer and a `versions` map. Each `ActionVersion` is
`{ inputSchema, run }` — schema and behavior live together and can't drift. Old versions stay as
long as any automation pins them.

- **Action lookup is strict** — an automation pinned to an unknown action version throws at dispatch.
- **Event version at dispatch is lenient** — conditions evaluate against whatever payload was raised;
  the automation's `eventVersion` is informational/audit.
- `createAutomationFramework` validates at boot: every schema's `latest` exists, every declared
  action version has a registered handler, every `ref.source` is registered, every event type has a
  `ContextBuilder`.

You carry old handler versions until every automation pinned to them is migrated — set a sunset
policy early.

## Reload

Automations are indexed by event type up front: on boot and after every create/update/delete the
enabled automations are grouped and one condition engine is built per type via `engine.reload()`.
**Any `store.upsert`/`remove` must be followed by `engine.reload()`** or evaluation runs against
stale rules.


## Flow

 fire(type, payload) → validate & normalize payload → build event envelope → open audit run → flatten event to a fact map → run pre-compiled conditions → for each match, interpolate inputs + execute actions in order
 (auditing each) → finalize audit run (matches + status) → return.

  Three things worth remembering: it's synchronous, in-process, no queue — fire() returns only after all matched actions finish; the audit run brackets the whole thing (opened before, closed after) so even no-match, dropped and
  failed fires are recorded; and a partitioned automation's match is skipped when the event's partition differs. Currently not horizontally scaleable 


## Files

| File | What it does |
| --- | --- |
| `types.ts` | Pure contract/domain types (`Automation`, `AppEvent`, schemas, `Catalog`, …). |
| `query-builder-types.ts` | Vendored subset of react-querybuilder tree types, so the server reads conditions without the React lib. |
| `qb-to-engine.ts` | Converts the query-builder condition tree into json-rules-engine conditions + operator map. |
| `schema-to-zod.ts` | Derives Zod validators from catalog schemas. |
| `validate.ts` | `createValidators(schemas)` — validates action inputs and event payloads (cached). |
| `interpolate.ts` | Resolves `{{...}}` templates in action inputs at fire time. |
| `context.ts` | **Seam A.** `ContextBuilder` + the stateless builder that flattens an event into facts. |
| `actions.ts` | **Seam C.** `ActionHandler`, `ActionRegistry`, required-input check. |
| `store.ts` | `AutomationStore` interface (storage seam). Implementations live in the app. |
| `refs.ts` | `RefSource` / `RefRegistry` — picker data sources for ref-typed inputs. |
| `catalog.ts` | `buildCatalog(...)` — the editor catalog (fields, variables, operators) a UI renders from. |
| `engine.ts` | Evaluation core. Indexes automations per event type, builds a json-rules-engine per type, `dispatch()` with the partition filter and hop guard. |
| `framework.ts` | `createAutomationFramework(config)` — assembles engine, validators, `fire()` (envelope: partition, scope, chain fields) and `causeOf()`. |
| `framework.test.ts` | Unit tests for partitions, the event envelope and the hop limit (`pnpm test`). |
| `index.ts` | Public barrel. |

# Triggers — app composition root

This folder is **this app's domain + wiring** for the trigger framework. The reusable engine
(event → conditions → action, the seams, validation, interpolation) lives in the
[`@rw/triggers`](../../../../packages/triggers/README.md) package — start there for the seam model,
the `fire()` contract, and how an event flows through the engine (and its
[`WALKTHROUGH.md`](../../../../packages/triggers/WALKTHROUGH.md) for wiring the engine into a new app).

Everything here is what makes the engine *this app's*: the concrete event/action **schemas**, the
**handlers** that do real work, the **fact builders**, the **store**, and the call that assembles
them into the engine.

## The split

```
@rw/triggers (package)            apps/api/src/triggers (this folder)
─────────────────────             ───────────────────────────────────
engine, ingestion, validation,    events/        one module per event type
interpolation, catalog builder,                  (schema + ContextBuilder colocated)
seam interfaces, fire()           actions/       one module per action type
                                                 (schema + ActionHandler colocated)
                                  refs.ts        RefSource + getXById helpers
                                  store.ts       seed + file-backed store mock
   createTriggerFramework(cfg) ◀──── createAppTriggerFramework() (index.ts)
```

The dependency only points one way: this folder imports from `@rw/triggers`; the package never
imports app code. That boundary is what keeps the engine reusable.

## Files

| File / folder | What it does |
| --- | --- |
| `events/<type>.ts` | One file per event type. Exports `schema: EventSchema` + `contextBuilder: ContextBuilder` — colocated so they can't drift. (e.g. `events/job-changed.ts`.) |
| `events/index.ts` | Aggregator. Collects every event module into `EVENT_SCHEMAS` + `buildContextBuilders()`. Add a new event = drop a file in `events/`, add one import line here. |
| `actions/<type>.ts` | One file per action type. Exports `schema: ActionSchema` + `handler: ActionHandler` — colocated, handler reuses `schema.type` and `schema.inputSchema` directly. (e.g. `actions/send-alert.ts`.) |
| `actions/index.ts` | Aggregator. Collects every action module into `ACTION_SCHEMAS` + `buildActionRegistry()`. Add a new action = drop a file in `actions/`, add one import line here. |
| `refs.ts` | `RefSource` implementations + `getXById` helpers. Today: in-memory users fixture (mock for a future `@rw/db` users table). One file per source as this grows. |
| `store.ts` | A MOCK file-backed `TriggerStore` (persists triggers to JSON for dev) + the seed trigger. Swap for a `@rw/db`-backed store later; nothing else changes. |
| `index.ts` | Composition root — `createAppTriggerFramework()` feeds the aggregators into `@rw/triggers`' `createTriggerFramework()`, and `getTriggerFramework()` is the shared singleton the oRPC layer uses. |

## Raising an event

In-process only — no HTTP endpoint. Get the shared framework and call `fire(type, payload)`. It
throws on a bad payload, an unknown event type, or any misconfigured matched action:

```ts
import { getTriggerFramework } from "./triggers/index.js";

// e.g. inside the code path that persists a job change
const fw = getTriggerFramework();
try {
  const { eventId, matched } = await fw.fire("job.changed", {
    previousJob: "J-100",
    currentJob: "J-200",
    station: "S-1",
  });
  // eventId → generated event id (for tracing); matched → matched trigger ids
} catch (err) {
  log.warn(`fire failed: ${(err as Error).message}`);
}
```

See [`@rw/triggers`](../../../../packages/triggers/README.md#error-model) for the framework-wide
error model and the `ingest.submit` escape hatch.

## Adding things

- **New action** → create `actions/<type>.ts` exporting `schema` + `handler`, then add one import
  line to `actions/index.ts`. Schema and handler live in the same module so they can't disagree.
  Validation and the editor form derive automatically.
- **New event type** → create `events/<type>.ts` exporting `schema` + `contextBuilder`, then add
  one import line to `events/index.ts`. Use `statelessContextBuilder` from `@rw/triggers` unless
  the event needs joined data.
- **New ref data source** (picker for an action input) → add a `RefSource` to `refs.ts` and chain
  `.register(...)` in `index.ts`. Annotate the relevant action input's `SchemaProperty` with
  `ref: { source: "<key>" }`.

## Trace

For a concrete, value-by-value trace of one event (the seed trigger) through every step, see
[`WALKTHROUGH.md`](./WALKTHROUGH.md).

## Test

An end-to-end smoke test against the mock store lives at
[`apps/api/scripts/triggers-e2e.ts`](../../scripts/triggers-e2e.ts):

```bash
pnpm --filter @rw/api exec tsx scripts/triggers-e2e.ts
```

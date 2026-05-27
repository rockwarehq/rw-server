# Trigger framework

A small, event-driven trigger engine: an **event** comes in, its **conditions** are
evaluated, and if they match, an **action** runs. It is deliberately flat and stateless — one
event → one condition group → one action, evaluated to completion in a single pass.

The design goal is that the evaluation core never changes. Everything that *does*
vary — how an event becomes facts, how events arrive, what an action does, where
triggers are stored — is reached through a **seam**.

## What "seam" means here

A **seam** is a place where the inputs and outputs stay fixed but the code behind
them can be swapped out. Think of it as a labeled slot: the engine calls into the
slot with a known input and gets back a known output, and you can drop a different
implementation into that slot without touching any of the code around it.

In practice a seam is an **interface** whose concrete implementation is chosen from
the *outside* (here, in `registry.ts` / `index.ts`) rather than hardcoded in the
engine. That's the important part:

- Adding a new behavior = write a new implementation of the interface and register
  it. The engine, ingestion, and validation are never edited.
- Contrast with a **branch** (an inline `if`/`switch`): there the choice is baked
  into the code and you must edit that spot to add a case. A seam moves the choice
  out of the code. Same input/output contract is what makes the swap safe; the
  decision living *outside* the code is what makes it a seam rather than a branch.

### The seams in this framework

| Seam | Interface | What you swap | File |
| --- | --- | --- | --- |
| A — event → facts | `ContextBuilder` | how an event is turned into the fact map conditions read | `context.ts` |
| B — event delivery | `IngestRuntime` | how events get into the engine (sync now; a queue later) | `ingest.ts` |
| C — what an action does | `ActionHandler` / `ActionRegistry` | the effect a matched trigger runs (alert, email, …) | `actions.ts` |
| Definition storage | `TriggerStore` | where trigger definitions live (mock file now; `@rw/db` later) | `store.ts` |
| Observability | `Notify` | where lifecycle notifications go (console now; WS/SSE later) | `types.ts` |

All implementations are wired together in the composition root (`registry.ts`,
assembled by `index.ts`) — the one place you edit to extend the framework.

## How an event flows

Triggers are **indexed by event type up front**: on boot, and again after every
create/update/delete, the enabled triggers are grouped by their event type and one
condition engine is built per type. So at runtime "find the triggers for this event"
is just a lookup, and evaluation only decides which of that type's triggers *match*.

The runtime path (an event firing) looks like this:

```
SETUP (boot, and after any trigger create/update/delete)
  enabled triggers ──grouped by event type──▶ one condition engine per event type
        │
        ▼  (index ready)
══════════════════════════════════════════════════════════════════════════════
RUNTIME (an event fires — raised in-process; see "Raising an event" below)

  (1) your code calls fire(type, payload)
        │
  (2) validate payload vs the event type's schema ──✗ invalid──▶ return { ok: false, error }
        │ ✓ valid (normalized payload)
        ▼
  (3) fire() builds the event: { id, type, ts, payload }
        │
  (4) look up the condition engine for this event type
        │
        ├─ none ─▶ no triggers for this type → done (matched: [])
        ▼
  (5) build facts from the event            (event ─▶ flat fact map)
        │
  (6) evaluate every condition for this type ─▶ the set of matched triggers
        │
  (7) for each matched trigger:
        │      • resolve its action handler by type
        │      • interpolate {{...}} variables into the inputs
        │      • check required inputs are present
        │      • run the action
        ▼
  (8) return { ok: true, eventId, matched }
```

By file / function. Across the four phases below, every file in this folder appears
at least once — `types.ts` is the shared contract used throughout and so isn't pinned
to a single step:

```
─── BOOT / WIRING ── index.ts createTriggerFramework(), once at startup ──────────
  registry.ts        buildContextBuilders() ─▶ Map<eventType, ContextBuilder>   (context.ts)
  registry.ts        buildActionRegistry()  ─▶ ActionRegistry of handlers       (actions.ts)
  store.ts           createFileTriggerStore()
  index.ts           new TriggerEngine({...}) then engine.reload()

─── AUTHORING a trigger ── rpc/triggers.ts create/update ─────────────────────────
  rpc/triggers.ts    validateActionInputs(action.type, inputs)
        │              └─ validate.ts ─▶ schema-to-zod.ts (actionInputsToZod) ◀─ catalog.ts schemas
        ▼
  rpc/triggers.ts    store.upsert(trigger)   (store.ts; trigger.conditions typed by query-builder-types.ts)
        │
        ▼
  rpc/triggers.ts    engine.reload()         (engine.ts)  ──┐
                                                            │ (also runs at boot, above)
─── SETUP / INDEX ── engine.reload(), boot + after each authoring change ─────◀────┘
  engine.ts          store.list() ─▶ group enabled triggers by event type      (store.ts)
  engine.ts          buildEngine() per event type:
                       qbToEngineConditions(conditions)   (qb-to-engine.ts ◀─ query-builder-types.ts)
                       new Engine(...)                    (json-rules-engine)

─── RUNTIME ── an event fires (raised in-process) ─────────────────────────────────
  (1) your producer          getTriggerFramework().fire(type, payload)
        │                      (or fw.ingest.submit(event) to skip validation, pre-built event)
        ▼
  (2) validate.ts            validateEventPayload(type, payload)  ──✗──▶ { ok: false, error }
        │                      cached zod validator (via schema-to-zod.ts) ◀─ catalog.ts schemas
        ▼
  (3) index.ts               fire() builds the AppEvent (shape from types.ts)
        │                      └─▶ ingest.ts  SyncIngestRuntime.submit()
        ▼
  (4) engine.ts              dispatch(): this.engines.get(event.type)
        │
  (5) context.ts             ContextBuilder.build(event)            ── SEAM A
        │
  (6) json-rules-engine      engine.run(facts) ─▶ matched results
        │
  (7) engine.ts              runAction():
        │                      • actions.ts    ActionRegistry.get(type)   ── SEAM C
        │                      • interpolate.ts interpolateInputs(inputs, { event })
        │                      • actions.ts    missingRequired(inputs, schema)
        │                      • handler.run(...)  (the registered handler)
        ▼
  (8) engine.ts              dispatch() returns matched ids
```

Note the validators (`validate.ts`) run on the **trigger write path** in `rpc/triggers.ts`
(create/update) and on the **event entry** in `fire()` (which validates the payload against
the event type's schema). They do **not** run inside the engine: the runtime path re-checks
only input *presence* (`missingRequired`), not the full zod schema, trusting that the event
and trigger were validated on the way in. The lower-level `ingest.submit()` seam does **not**
validate — it's the escape hatch for pre-validated or trusted events.

For a concrete, value-by-value trace of one event through every step above, see
[`WALKTHROUGH.md`](./WALKTHROUGH.md).

## Raising an event

Events are raised **in-process** — there is no HTTP endpoint for firing them. Wherever
the app detects something worth reacting to (e.g. a job change is persisted), get the
shared framework and call `fire(type, payload)`. It validates the payload against the
event type's schema, builds the event (generates `id` and `ts`), runs it through the
engine, and returns a result you check before using:

```ts
import { getTriggerFramework } from "./triggers/index.js";

// e.g. inside the code path that handles a job change
const fw = getTriggerFramework();
const result = await fw.fire("job.changed", {
  previousJob: "J-100",
  currentJob: "J-200",
  station: "S-1",
});

if (!result.ok) {
  // payload didn't match the event type's schema (or the type is unknown)
  log.warn(`invalid job.changed event: ${result.error}`);
} else {
  // result.eventId → the generated event id (for tracing)
  // result.matched → ids of triggers whose conditions matched, e.g. ["trg_seed"]
}
```

`fire()` returns a discriminated union, so a bad payload never throws:

```ts
type FireResult =
  | { ok: false; error: string }
  | { ok: true; eventId: string; matched: string[] };
```

Validation reuses the same zod schema as the editor/RPC (derived from `catalog.ts`), so an
unknown event type or a payload that violates the schema comes back `{ ok: false }`. The
**normalized** payload is what gets dispatched — unrecognized keys are dropped.

If you already have a fully-formed, trusted event (your own `id` / `ts`, already validated),
skip validation and submit straight to the ingest seam — note this path does **not** validate:

```ts
await fw.ingest.submit({
  id: "evt_1",
  type: "job.changed",
  ts: new Date().toISOString(),
  payload: { previousJob: "J-100", currentJob: "J-200", station: "S-1" },
});
```

## Files

| File | What it does |
| --- | --- |
| `types.ts` | Pure contract/domain types shared everywhere (`Trigger`, `AppEvent`, schemas, `Catalog`, notifications). No logic. |
| `catalog.ts` | Single source of truth for event + action **schemas** (`EVENT_SCHEMAS`, `ACTION_SCHEMAS`), and builds the `Catalog` the editor UI renders from (fields, template variables, operators). |
| `query-builder-types.ts` | Minimal vendored subset of react-querybuilder's tree types (`RuleGroupType` / `RuleType`), so the server can read conditions without depending on the React library. |
| `qb-to-engine.ts` | Converts the query-builder condition tree into json-rules-engine conditions, and defines the operator map (`=` → `equal`, `contains` → `stringContains`, …). |
| `schema-to-zod.ts` | Derives Zod validators from the catalog schemas, so validation falls out of the same declaration the editor uses — no hand-written validators. |
| `validate.ts` | Validates action inputs and event payloads against those derived Zod schemas (validators are built once and cached). |
| `interpolate.ts` | Resolves `{{...}}` template variables in action inputs at fire time (`event.payload.*`, `event.id`, `sys.timestamp`, …). |
| `context.ts` | **Seam A.** `ContextBuilder` interface + the stateless builder that flattens an event into the fact map conditions are evaluated against. |
| `actions.ts` | **Seam C.** `ActionHandler` interface, `ActionRegistry`, the example `sendAlert` handler, and the required-input check. |
| `ingest.ts` | **Seam B.** `IngestRuntime` interface + `SyncIngestRuntime` (evaluates inline on the calling request). |
| `store.ts` | `TriggerStore` interface (definition-storage seam) + a mock file-backed implementation that persists triggers to JSON for development. |
| `engine.ts` | The evaluation core. Indexes enabled triggers per event type, builds a json-rules-engine per type, then `dispatch()` turns an event into facts, evaluates conditions, and runs the action of each matched trigger. |
| `registry.ts` | Composition root — maps event types to their `ContextBuilder`s and registers `ActionHandler`s. The one place to extend when adding an event or action type. |
| `index.ts` | Public entry point. Assembles the framework (`createTriggerFramework` / `getTriggerFramework`), exposes `store` / `engine` / `ingest` / `catalog` / `fire`, and re-exports the public types. |

## Adding things

- **New action** → add its schema to `ACTION_SCHEMAS` (`catalog.ts`), write an
  `ActionHandler` (`actions.ts`), register it in `registry.ts`. Validation and the
  editor form derive automatically.
- **New event type** → add its schema to `EVENT_SCHEMAS` (`catalog.ts`); register a
  `ContextBuilder` for it in `registry.ts` if it needs more than its raw payload as
  facts (otherwise it uses the default stateless builder).

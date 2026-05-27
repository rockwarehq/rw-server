# End-to-end trace

A concrete, value-by-value walk of **one event** through the framework, using the
seed trigger. Read alongside the diagrams in [`README.md`](./README.md) ("How an event
flows") — the diagrams show the shape, this shows the actual data at each step.

## Given: the seed trigger (already loaded)

`store.ts` seeds one trigger, and at boot `engine.reload()` grouped it under
`job.changed` and compiled its condition into a json-rules rule whose event carries the
trigger id (`event: { type: "trg_seed" }`):

```ts
{
  id: "trg_seed",
  label: "Alert on job change at S-1",
  enabled: true,
  event: "job.changed",
  conditions: { combinator: "and", rules: [
    { field: "event.payload.station", operator: "=", value: "S-1" },
  ] },
  action: { type: "sendAlert", inputs: {
    text: "Job changed from {{event.payload.previousJob}} to {{event.payload.currentJob}} at {{event.payload.station}}",
    emails: ["supervisor@example.com"],
  } },
}
```

## When: we raise an event

```ts
const result = await fw.fire("job.changed", {
  previousJob: "J-100",
  currentJob: "J-200",
  station: "S-1",
});
```

## The trace

### 1. `fire()` validates the payload — `index.ts`
Calls `validateEventPayload("job.changed", payload)` (`validate.ts`):
- looks up `EVENT_SCHEMAS["job.changed"]` (`catalog.ts`) — found.
- runs the cached zod validator → **ok**, returns the normalized value:
  ```ts
  { previousJob: "J-100", currentJob: "J-200", station: "S-1" }
  ```
If it were invalid, `fire()` would return `{ ok: false, error }` here and stop.

### 2. `fire()` builds the event — `index.ts`
Wraps the normalized payload in an `AppEvent` envelope (generates `id` + `ts`):
```ts
{
  id: "a1b2c3d4",                       // nanoid(8)
  type: "job.changed",
  ts: "2026-05-27T15:00:00.000Z",       // new Date().toISOString()
  payload: { previousJob: "J-100", currentJob: "J-200", station: "S-1" },
}
```

### 3. `ingest.submit(event)` — `ingest.ts` (SEAM B)
`SyncIngestRuntime` forwards straight to `engine.dispatch(event, notify)`. (Swap this
seam for a queue later; the engine call is unchanged.)

### 4. `dispatch()` announces + routes — `engine.ts`
- `notify({ type: "eventReceived", event })` → lifecycle ping.
- `this.engines.get("job.changed")` → the condition engine holding this type's triggers.
  (No engine for the type → `return []`, and `fire()` resolves `{ ok: true, matched: [] }`.)

### 5. `dispatch()` builds facts — `context.ts` (SEAM A)
`statelessContextBuilder.build(event)` flattens the event into the fact map:
```ts
{
  "event.type": "job.changed",
  "event.payload.previousJob": "J-100",
  "event.payload.currentJob": "J-200",
  "event.payload.station": "S-1",
}
```

### 6. `engine.run(facts)` evaluates conditions — `engine.ts` → json-rules-engine
The seed rule's condition is `{ all: [{ fact: "event.payload.station", operator: "equal", value: "S-1" }] }`.
The fact `"event.payload.station"` is `"S-1"` → **passes**. `results` comes back with one
entry carrying `event: { type: "trg_seed" }`.

### 7. `dispatch()` maps the result back to a trigger — `engine.ts`
- `triggerId = "trg_seed"`.
- `store.get("trg_seed")` → the full trigger (re-fetched because the rule only carried the id).
- `matched.push("trg_seed")`.
- `notify({ type: "triggerFired", triggerId: "trg_seed", label: "Alert on job change at S-1", eventId: "a1b2c3d4" })`.
- `await runAction(trigger, event, notify)` → step 8.

### 8. `runAction()` executes the action — `engine.ts` (SEAM C)
1. `actions.get("sendAlert")` → `sendAlertHandler` (`actions.ts`).
2. `interpolateInputs(action.inputs, { event })` (`interpolate.ts`) resolves the `{{...}}`:
   ```ts
   {
     text: "Job changed from J-100 to J-200 at S-1",
     emails: ["supervisor@example.com"],
   }
   ```
3. `missingRequired(inputs, handler.inputSchema)` — `sendAlert` requires `["text","emails"]`; both present → `null` (ok).
4. `await handler.run(inputs, { trigger, eventId: "a1b2c3d4", notify })`:
   - logs: `[triggers] ALERT (Alert on job change at S-1): Job changed from J-100 to J-200 at S-1 -> supervisor@example.com`
   - `notify({ type: "actionRan", triggerId: "trg_seed", action: "sendAlert", eventId: "a1b2c3d4" })`.

### 9. Unwind — back to the caller
```
runAction resolves
  └─ dispatch loop ends → returns ["trg_seed"]
       └─ ingest.submit resolves
            └─ fire() returns:
               { ok: true, eventId: "a1b2c3d4", matched: ["trg_seed"] }
```

Three lifecycle notifications were emitted to the `notify` sink along the way:
`eventReceived` → `triggerFired` → `actionRan`. (The default console logger only prints
`triggerFired`; point the sink at WS/SSE/audit to use the others.)

## The same event, three other outcomes

- **Condition doesn't match** — `station: "S-2"`. Steps 1–6 run; the rule fails at step 6,
  `results` is empty, nothing is pushed to `matched`. `fire()` returns
  `{ ok: true, eventId, matched: [] }`. (Valid event, just nobody cared.)

- **Invalid payload** — `station: 123` (a number, schema wants a string). Step 1 fails;
  `fire()` returns `{ ok: false, error: "station: Expected string, received number" }`.
  No event is built, the engine is never touched.

- **Unknown event type** — `fire("foo.bar", {})`. Step 1's catalog lookup misses;
  `fire()` returns `{ ok: false, error: "unknown event type: foo.bar" }`.

## Misconfigured-but-matching trigger (the `matched` caveat)

If the seed trigger's conditions matched but its action were broken (e.g. action type
`"sendSms"` with no registered handler, or a required input left empty), step 8 logs a
warning and returns *without throwing*. Because `matched.push(...)` happened in step 7
**before** `runAction`, the id is still in `matched`. So `matched` means "conditions
passed and the action was attempted," not "the action ran successfully" — use the
`actionRan` notification if you need a true success signal.

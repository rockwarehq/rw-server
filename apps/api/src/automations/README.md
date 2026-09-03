# Automations (this app)

This app's domain + wiring for the automation engine. The reusable engine lives in
[`@rw/automations`](../../../../packages/automations/README.md); this folder supplies the concrete
**event/action schemas**, the **handlers** that do the work, the **fact builders**, and the
composition root that assembles them.

```
events/<type>.ts    one event:  schema (versioned) + contextBuilder
actions/<type>.ts   one action: handler with all versions inside
index.ts            composition root — createAppAutomationFramework()
```

The DB-backed seams (store, audit recorder, ref sources for the pickers) live in `@rw/services` and
are wired in by `index.ts`.

## How to use

Get the shared framework and `fire()` an event in-process:

```ts
import { getAutomationFramework } from "./automations/index.js";

const fw = await getAutomationFramework();
const { eventId, matched } = await fw.fire("job.changed", {
  siteId: "site_1",
  previousJobId: "j_100",
  jobId: "j_200",
  stationId: "s_1",
});
```

`fire()` throws on a bad payload, unknown event type, or a misconfigured matched action — wrap it if
you want graceful handling.

Every event payload carries `siteId`: it is the framework's partition, so an automation only sees its
own site's events. When an action calls into another domain that will raise its own event, pass
`causeOf(ctx.event)` along so the next `fire()` continues the chain (`correlationId`, `causationId`,
`hop`); the framework drops anything more than 5 hops deep and records it as a `DROPPED` run.

## Events and actions today

| Event | Fed by | About (`scopeKey`) |
| --- | --- | --- |
| `job.changed` | `jobs.>` stream | station |
| `call.changed` | `calls.>` stream via the automation event consumer | call |
| `mode.changed` | `modes.>` stream | station |
| `notification.changed` | `notifications.>` stream | notification |

| Action | Does |
| --- | --- |
| `notify` | `notification.send` to groups and/or people; dedupe key = event id + automation + action index |
| `openCall` / `closeCall` | open (or close the open) call of a definition at a station |
| `forceMode` / `clearMode` | force a station into / out of a production mode |

Every domain call an action makes is `source: SYSTEM`, `sourceType: "automation"`, `sourceRef: <automation id>`,
with `causeOf(event)` attached, so the domain's own outbound event continues the chain. Station-targeting
actions default to the station the event was about when `stationId` is blank.

The bridge is `src/nats/automation-event-consumer.ts`: one durable JetStream consumer per domain stream,
mapped by the `from*Event` function next to each event schema, fired with the domain event's id so a
redelivery yields the same automation event id.

## Adding things

- **New action** → add `actions/<type>.ts`, then one import line in `actions/index.ts`.
- **New event** → add `events/<type>.ts` (use `statelessContextBuilder` unless it needs joined data),
  then one import line in `events/index.ts`. Declare `siteId` in the payload (boot fails otherwise)
  and a `scopeKey` naming what the event is about.
- **New version** → add a `"2"` entry to that action/event's `versions` map; keep `"1"` while any
  automation pins it.
- **New ref picker** → add a `RefSource` under `@rw/services` (use `createNameRef`, which filters by the
  editor's `siteId`) and `.register(...)` it in `index.ts`.
- **New domain stream as a trigger** → event module with a `from<Domain>Event` mapper, then one entry in
  `BRIDGES` in the consumer.

## Notes

- **Just-in-time, no queue.** Events fire synchronously in-process — no broker, no background worker.
  `fire()` runs the matched automations' actions in order and returns when they're done.
- **In-memory + reload.** Automations are cached in memory; every create/update/delete must call
  `engine.reload()` (the RPC handlers do this). A write that bypasses them runs against stale rules.
- **Horizontal scaling — not implemented.** The cache is per-instance, so a config upsert/delete only
  refreshes the instance that handled it. Scaling the API to multiple instances needs Redis pub/sub to
  notify the others to reload. Single-instance until that lands.

## Test

End-to-end against the real DB (needs `DATABASE_URL`):

```bash
pnpm --filter @rw/api exec tsx scripts/automations-db-e2e.ts
```

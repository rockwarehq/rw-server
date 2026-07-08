# @rw/livestore-app

The Reactive Graph Engine (see `spec.md`): live values mirrored into a reactive
graph and fanned out to dashboards over WebSocket. Two input paths feed the same
engine:

```text
metrics worker (MetricBucket change)
  -> graph NATS bridge (packages/services/src/metrics/graph-nats-bridge.ts)
  -> NATS subject metrics.<stationId>.SHIFT.<metricKey>
  -> MetricResolver (UI-authored metric properties)
  -> optional UI-authored rollup / expr properties
  -> NATS KV `cvg` (current value table)
  -> WebSocket /graph/live -> dashboards

NATS tag message (tags.<deviceId>.<tagPath>)
  -> TagResolver -> commitValue() -> NATS KV `cvg` -> WebSocket clients

API graph authoring write
  -> JetStream graph definition event (`graph.definitions.<siteId>`)
  -> LiveStore durable consumer
  -> incremental kernel/resolver patch without restarting the graph
```

## How it fits together

- **Metric catalog** (`metricCatalog.ts`) — the declared KPI layer (additive counters
  + ratio formulas); the mirrored key set lives in `@rw/runtime/graph-subjects` so
  the worker bridge and this consumer can't drift. The entity/data catalog is owned
  by the API entity service and combines service-defined system records with
  user-authored `ObjectSchema` definitions.
- **Graph authoring** — nodes and properties are created through the API/UI against
  the entity catalog. LiveStore does not materialize graph nodes or tag properties
  on boot.
- **Engine** (`kernel.ts`, `scheduler.ts`, `runtime.ts`) — in-memory DAG, dirty-set
  coalescing (50ms), topo-ordered flush; authored rollups/exprs recompute from
  their dependencies. Authored graph definition changes are applied as NATS-backed
  hot patches, with a periodic Postgres reconciliation pass as a safety net.
- **WS gateway** (`server.ts`) — subscribe/unsubscribe per property id; initial
  value from KV, then KV watch; per-connection backpressure.

## Run locally

Requirements: Postgres via `DATABASE_URL`, NATS with JetStream, and a local env file
(`cp apps/livestore/.env.example apps/livestore/.env`).

```bash
docker compose up -d nats            # JetStream-enabled NATS
pnpm --filter @rw/db db:migrate      # GraphNode / GraphProperty / GraphEdge tables
pnpm --filter @rw/livestore-app dev      # boots authored graph, opens /graph/live on :30100
```

Simulate the worker (publishes ramping SHIFT goodItems for a few stations):

```bash
pnpm --filter @rw/livestore-app playground:simulate
```

Simulate datasource tag values for the devices/points added in the app:

```bash
pnpm --filter @rw/livestore-app simulate:tags -- --list
pnpm --filter @rw/livestore-app simulate:tags
```

`simulate:tags` publishes `ValueEnvelope` messages to `tags.<datasourceId>.<pointId>`
for datasources with a site, including DRAFT devices added in the app. Filter with
`--datasource-ids`, `--site-id`, `--gateway-id`, or `--point-ids`; use `--once`
for a single batch and `--dry-run` or `--list` to inspect subjects without
publishing. Use `--active-only` to ignore drafts. Create matching graph tag
properties in the UI with resolver `{ "type": "tag", "deviceId": datasource.id,
"tagPath": point.id }`; LiveStore subscribes to new tag properties through the
graph definition hot-patch path.

Or exercise the tag path (creates a tag-backed node, then publishes envelopes):

```bash
pnpm --filter @rw/livestore-app fixture:create
pnpm --filter @rw/livestore-app fixture:publish
```

Watch values: `GET /graph/nodes` for ids, then over WS

```json
{ "op": "subscribe", "propertyIds": ["<propertyId>"] }
```

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /health`, `/healthz`, `/readyz` | liveness / NATS readiness |
| `GET /graph/nodes` | nodes + properties + current values |
| `GET /graph/nodes/:id` | one node |
| `GET /graph/live` | WebSocket subscribe/unsubscribe per property |
| `GET /ws/graph` | deprecated alias for `/graph/live` (removal pending client migration) |

## Tests

```bash
pnpm --filter @rw/livestore test     # engine unit tests (packages/livestore)
pnpm --filter @rw/services test      # NATS bridge publish mapping
```

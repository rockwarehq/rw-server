# @rw/livestore

The Reactive Graph Engine (see `spec.md`): live values mirrored into a reactive
graph and fanned out to dashboards over WebSocket. Two input paths feed the same
engine:

```text
metrics worker (MetricBucket change)
  -> graph NATS bridge (packages/services/src/metrics/graph-nats-bridge.ts)
  -> NATS subject metrics.<stationId>.SHIFT.<metricKey>
  -> MetricResolver (Station leaf properties)
  -> rollup{sum} on Workcenter / Site + ratio exprs (oee, availability, ...)
  -> NATS KV `cvg` (current value table)
  -> WebSocket /ws/graph -> dashboards

NATS tag message (tags.<deviceId>.<tagPath>)
  -> TagResolver -> commitValue() -> NATS KV `cvg` -> WebSocket clients
```

## How it fits together

- **Metric catalog** (`metricCatalog.ts`) — the declared KPI layer (additive counters
  + ratio formulas); the mirrored key set lives in `@rw/runtime/graph-subjects` so
  the worker bridge and this consumer can't drift. The entity/data catalog is owned
  by the API entity service and backed by `ObjectSchema`.
- **Node sync** (`node-sync.ts`) — materializes one GraphNode per Site/Workcenter/
  Station and each kind's property schema: metric leaves on Stations, `rollup{sum}`
  on Workcenter/Site, ratio KPIs as exprs at every level. Idempotent; runs on boot
  (`LIVESTORE_SYNC_NODES_ON_BOOT`) or via `pnpm --filter @rw/livestore sync:nodes`.
- **Engine** (`kernel.ts`, `scheduler.ts`, `runtime.ts`) — in-memory DAG, dirty-set
  coalescing (50ms), topo-ordered flush; rollups/exprs recompute bottom-up so a
  station counter change lands in workcenter and site KPIs in one pass.
- **WS gateway** (`server.ts`) — subscribe/unsubscribe per property id; initial
  value from KV, then KV watch; per-connection backpressure.

## Run locally

Requirements: Postgres via `DATABASE_URL`, NATS with JetStream, and a local env file
(`cp apps/livestore/.env.example apps/livestore/.env`).

```bash
docker compose up -d nats            # JetStream-enabled NATS
pnpm --filter @rw/db db:migrate      # GraphNode / GraphProperty / GraphEdge tables
pnpm --filter @rw/livestore dev      # boots, syncs nodes, opens /ws/graph on :30100
```

Simulate the worker (publishes ramping SHIFT goodItems for a few stations):

```bash
pnpm --filter @rw/livestore playground:simulate
```

Or exercise the tag path (creates a tag-backed node, then publishes envelopes):

```bash
pnpm --filter @rw/livestore fixture:create
pnpm --filter @rw/livestore fixture:publish
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
| `GET /ws/graph` | WebSocket subscribe/unsubscribe per property |

## Tests

```bash
pnpm --filter @rw/livestore test     # engine scheduler unit tests
pnpm --filter @rw/services test      # NATS bridge publish mapping
```

# Livestore

`@rw/livestore` is the first slice of the Reactive Graph Engine. It runs the tag-backed live value pipeline:

```text
NATS tag message -> TagResolver -> commitValue() -> in-memory current cache -> NATS KV cvg -> WebSocket clients
```

## Requirements

- Postgres available through `DATABASE_URL`
- NATS with JetStream enabled
- `apps/livestore/.env` present for local dev

Optional env vars:

- `NATS_URL`, defaults to `nats://localhost:4222`
- `PORT`, defaults to `30100`
- `HOST`, defaults to `::`

## Start NATS

```sh
docker run --rm -p 4222:4222 nats:latest -js
```

## Prepare Database

Run from the repo root:

```sh
pnpm db:migrate:dev
pnpm db:generate
```

## Create Test Fixture

Run from the repo root:

```sh
pnpm --filter @rw/livestore fixture:create
```

This creates or updates:

- GraphNode: `Press 7`
- GraphProperty: `cycleTime`
- Resolver: `{ "type": "tag", "deviceId": "press7-plc", "tagPath": "cycleTime" }`

The default derived NATS subject is:

```text
tags.press7-plc.cycleTime
```

The command prints the `propertyId`; use that for websocket subscription testing.

## Start Livestore

Run from the repo root:

```sh
pnpm --filter @rw/livestore dev
```

## Publish Test Tag Value

In another terminal, run from the repo root:

```sh
pnpm --filter @rw/livestore fixture:publish
```

By default, the helper publishes a random numeric value and a current timestamp so repeated runs produce visible updates:

```json
{
  "value": 14.8,
  "quality": "good",
  "timestamp": 1730000000000
}
```

Override fixture publish values with env vars:

```sh
GRAPH_VALUE=18.2 GRAPH_TIMESTAMP=1730000001000 pnpm --filter @rw/livestore fixture:publish
```

Publish the exact previous envelope again to test the no-change commit path:

```sh
pnpm --filter @rw/livestore fixture:publish -- --same
```

`--same` reuses the previous published envelope from a temp-file cache, including timestamp. Run `fixture:publish` once without `--same` first.

## HTTP Checks

```sh
curl http://localhost:30100/health
curl http://localhost:30100/graph/nodes
```

Fetch one node by ID:

```sh
curl http://localhost:30100/graph/nodes/<nodeId>
```

## WebSocket Test

Connect to:

```text
ws://localhost:30100/ws/graph
```

Send:

```json
{ "op": "subscribe", "propertyIds": ["<propertyId>"] }
```

Then publish another test value:

```sh
pnpm --filter @rw/livestore fixture:publish
```

The WebSocket client should receive:

```json
{
  "op": "value",
  "propertyId": "<propertyId>",
  "envelope": {
    "value": 12.4,
    "quality": "good",
    "timestamp": 1730000000000
  }
}
```

## Current Value Store

- KV bucket: `cvg`
- KV key format: `prop.<propertyId>`
- KV value: JSON `ValueEnvelope`

On boot, Livestore seeds each property's in-memory `current` value from `cvg`. If no KV entry exists, the property starts as a stale/null envelope using the current boot time:

```json
{ "value": null, "quality": "stale", "timestamp": 1730000000000 }
```

## Architecture Notes

- Resolvers do not write to KV directly.
- All value changes go through `commitValue()`.
- WebSocket clients subscribe by `propertyId`, never raw NATS subjects.
- `GraphEdge` is reserved for future property-to-property dependencies.
- The current tag-backed slice does not implement expressions, windows, rollups, entity resolvers, or dirty flush evaluation.

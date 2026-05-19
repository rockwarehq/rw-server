# rw-server-new (working name — will replace `rw-server`)

Monorepo consolidating `rw-server` and `rw-processor` into one workspace with
two deployables per tenant:

- **`apps/api`** — Fastify/oRPC HTTP server plus in-process BullMQ workers
  (stale-gateway-check, replay-reconcile, station-detect, dev-cycle-simulator).
- **`apps/workers`** — single binary, three startup modes selected by
  `--worker <name>`:
  - `rollups` — metric-bucket-ensure, metrics combined-tick, archive,
    shift-bucket-create, shift-change.
  - `processor` — MQTT ingest (ported from `rw-processor`).
  - `processor-consumer` — station-event-execution (was
    `rw-server/src/cycle-worker.ts`).

Shared:

- **`packages/db`** — Prisma schema, migrations, generated client.
- **`packages/runtime`** — events-bus, BullMQ tuning, logger, http healthcheck
  host, lifecycle (signal handling + drain timeout), shared job-payload types.

See `/home/michael/.claude/plans/i-d-like-to-moved-jaunty-flamingo.md` for the
full migration plan.

## Workspace commands

```sh
pnpm install
pnpm build                  # tsc -b across all packages
pnpm db:generate            # prisma generate
pnpm db:migrate             # prisma migrate deploy
pnpm db:migrate:dev         # prisma migrate dev
pnpm db:seed                # seed the DB
pnpm fly:deploy             # deploy with tenant overrides
```

## Status

Phase 0 (skeleton + stubs) — in progress.

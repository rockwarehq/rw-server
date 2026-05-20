# rw-server-new (working name — will replace `rw-server`)

Monorepo consolidating `rw-server` and `rw-processor` into one workspace with
two deployables per tenant:

- **`apps/api`** — Fastify/oRPC HTTP server plus in-process BullMQ workers
  (stale-gateway-check, replay-reconcile, station-detect, dev-cycle-simulator).
  Today it boots ALL background workers in-process (matching the old
  `SINGLE_PROCESS=1` mode); workers move out to `apps/workers` one at a time
  during cutover.
- **`apps/workers`** — single binary, three startup modes selected by
  `--worker <name>`:
  - `rollups` — metric-bucket-ensure, metrics combined-tick, archive,
    shift-bucket-create, shift-change.
  - `processor` — MQTT ingest (ported from `rw-processor`, still being
    integrated — see `apps/workers/src/workers/processor/index.ts`).
  - `processor-consumer` — station-event-execution (was
    `rw-server/src/cycle-worker.ts`).

The two worker modes that read from BullMQ (`rollups`, `processor-consumer`)
import their worker registrations from `@rw/api/...` — no source duplication,
just different startup composition.

Shared:

- **`packages/db`** — Prisma schema (lifted from `rw-server/prisma/`),
  migrations, generated client. `createPrismaClient(role)` factory sizes the
  pool per-process. `classifyDbTimeout()` lives here too.
- **`packages/runtime`** — events-bus (Redis pub/sub bridge), BullMQ tuning,
  logger, http-host (healthz/readyz/metrics tiny server), lifecycle (SIGTERM +
  drain timeout), shared job-payload types.

## Layout

```
rw-server-new/
├── pnpm-workspace.yaml
├── tsconfig.base.json + tsconfig.json (root project references)
├── apps/
│   ├── api/      (Dockerfile + fly/base.toml + fly/tenants/{sim,dixie,dev}.toml)
│   └── workers/  (Dockerfile + fly/base.toml + fly/tenants/{sim,dixie,dev}.toml)
├── packages/
│   ├── db/       (schema + migrations + generated client)
│   └── runtime/  (shared infra)
└── scripts/
    └── fly-deploy.ts
```

## Workspace commands

```sh
pnpm install
pnpm build                              # tsc -b across all packages
pnpm db:generate                        # prisma generate
pnpm db:migrate                         # prisma migrate deploy
pnpm db:migrate:dev                     # prisma migrate dev
pnpm db:seed
pnpm fly:generate --app api sim         # write apps/api/fly.generated.toml
pnpm fly:deploy   --app workers dixie   # validate secrets, deploy workers
```

## Deployment

Each tenant has two fly apps: one for `api` and one for `workers`. App names
come from the `app = '...'` line in each tenant's toml. For the `dev` tenant
today these are `rw-dev-api` and `dev-processor`.

Migrations run automatically inside the deploy via fly's `[deploy]
release_command = 'pnpm -w db:migrate'`, reading `DATABASE_URL_MIGRATION` from
the app's fly secrets. There is no separate migration step in CI or locally —
just `flyctl deploy`.

### First deploy for a new tenant

```sh
# 1. Create the two fly apps on the right org
flyctl apps create <tenant>-api      --org <org>
flyctl apps create <tenant>-workers  --org <org>

# 2. Set required secrets on each (lists live in apps/{api,workers}/fly/tenants/<tenant>.toml under [_meta].required_secrets)
flyctl secrets set -a <tenant>-api      DATABASE_URL='...' DATABASE_URL_MIGRATION='...' REDIS_URL='...' JWT_SECRET='...' ...
flyctl secrets set -a <tenant>-workers  DATABASE_URL='...' DATABASE_URL_ROLLUPS='...' DATABASE_URL_MIGRATION='...' REDIS_URL='...' PROCESSOR_SHARED_SECRET='...' MQTT_PASSWORD='...'

# 3. Pin machine count per process group. fly.toml has no `count` field —
#    counts are managed via the API and persisted on the app. Set once;
#    subsequent `flyctl deploy` runs preserve the count.
flyctl scale count -a <tenant>-workers rollups=1 processor=1 processor_consumer=1 --yes

# 4. First deploy (api first so workers/processor can reach it on boot)
pnpm fly:deploy --app api      <tenant>
pnpm fly:deploy --app workers  <tenant>
```

`PROCESSOR_SHARED_SECRET` and `REDIS_URL` must be **identical** on the api
and workers apps — workers signs callbacks the api verifies, and both speak
to the same Redis (BullMQ + events-bus pub/sub).

### Routine deploys

Either from your laptop:

```sh
pnpm fly:deploy --app api      <tenant>
pnpm fly:deploy --app workers  <tenant>
```

Or from GitHub Actions (workflow: `.github/workflows/fly-deploy.yml`,
trigger: "Deploy to Fly.io" → Run workflow). Pick `tenant` + `app=both`.

### Recovering a stopped machine

If a machine hits fly's 10-restart-loop limit (give-up state), `flyctl deploy`
will update its image but **not** restart it. Recovery is one command:

```sh
flyctl machine start <id> -a <tenant>-workers
```

Find the id via `flyctl machines list -a <app>` — look for `STATE: stopped`.

Alternative: destroy it and let scale recreate a fresh machine:

```sh
flyctl machine destroy <id> -a <app> --force
flyctl scale count -a <app> <group>=1 --yes
```

### Scaling later

To add redundancy in prod (e.g., two `processor_consumer` workers handling
the BullMQ queue), bump the count and fly creates additional machines:

```sh
flyctl scale count -a <tenant>-workers processor_consumer=2 --yes
```

Watch your Postgres `max_connections` budget when scaling — each rollups
machine takes `DB_POOL_SIZE` direct connections (default 10), each
pgbouncer-routed worker holds up to `DB_POOL_SIZE` client conns that
multiplex through pgbouncer's server pool.

## Status

Phase 0 (skeleton + shared packages): done.
Phase 1 (lift rw-server into apps/api with @rw/db / @rw/runtime rewiring): done.
Phase 2 (apps/workers binary + rollups + processor-consumer wired from
@rw/api source): done; `processor` mode is a documented stub pending
integration of `apps/workers/src/workers/processor/_ported/` (the copy of
rw-processor's MQTT pipeline — needs lifecycle refactor + .ts → .js extension
fixes + raw `pg` → Prisma migration before it builds).
fly.io configs + Dockerfiles + workspace fly-deploy.ts: done.

Next:
- Integrate `processor/_ported` (lifecycle, imports, Prisma migration).
- Lift seed scripts from `rw-server/prisma/seed/` into `packages/db/seed/`
  (the directory was copied during bootstrap but not wired to `pnpm db:seed`).
- Test the API container build end-to-end (`docker build -f apps/api/Dockerfile .`).
- Per-worker cutover (Phase 3 in the plan): for each worker, stop registering
  it in `apps/api/src/main.ts`, scale up its process group in
  `<tenant>-workers`, run the parity probe, soak, commit the cutover.

See `/home/michael/.claude/plans/i-d-like-to-moved-jaunty-flamingo.md` for the
full migration plan.

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

# Architecture Patterns

Write-ups of the system's structure and the recurring patterns implemented across apps and packages. One page per pattern — add new pages here and register them in the sidebar (see [How to Write Docs](../contributing)).

## System overview

```mermaid
graph TD
  api["apps/api<br/>Fastify + oRPC + in-process workers"] --> services[packages/services]
  api --> auth[packages/auth]
  workers["apps/workers<br/>rollups / processor / processor-consumer"] --> services
  livestoreApp[apps/livestore] --> livestore["packages/livestore<br/>reactive graph engine"]
  services --> db["packages/db<br/>Prisma"]
  services --> runtime["packages/runtime<br/>events bus, BullMQ, lifecycle"]
  workers --> runtime
  runtime --> redis[(Redis)]
  db --> pg[(PostgreSQL)]
  livestore --> nats[(NATS JetStream)]
```

## Patterns

_No pattern write-ups yet. Good candidates: the events bus (Redis pub/sub bridge), worker startup composition in `apps/workers`, per-principal JWT keys, the livestore reactive graph._

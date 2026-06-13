Reactive Graph Engine — Implementation Specification
1. Purpose
Build a user-configurable reactive computation graph for the IMM™ platform. Users define nodes that group one or more properties. Each property resolves to a live value from one of three sources: a PLC tag (via NATS), an entity property (from Postgres via Prisma), or an expression (mathjs over other properties). The engine reactively recomputes derived properties when inputs change and exposes current values to dashboards over WebSocket.
Mental model: a spreadsheet for the shop floor, where cells are grouped into named bundles (the way an OPC UA server groups variables under objects). Formulas reference other cells. Inputs come from the factory, not from typing.
2. Stack
Runtime: Node.js (LTS), TypeScript permitted, plain JS acceptable
Web server: Fastify
ORM: Prisma over Postgres
Message bus & KV: NATS with JetStream (KV bucket replaces Redis CVT)
Expressions: existing internal mathjs wrapper
Deployment: single Fly.io machine for the engine service (single-tenant)
No Redis. NATS KV is the durable current-value store. The engine holds the working graph in process memory.
3. Architecture
```
┌─────────────┐        ┌──────────────────────┐        ┌──────────────┐
│   Edge      │  NATS  │   Graph Engine       │ NATS KV│  WS Gateway  │
│  (PLC data) │───────▶│  (Fastify service)   │───────▶│  (Fastify)   │──▶ React
└─────────────┘        │                      │        └──────────────┘
                       │  - DAG in memory     │
┌─────────────┐ events │  - dirty set         │
│  Postgres   │───────▶│  - tick scheduler    │
│ (entities)  │        │  - expr evaluator    │
└─────────────┘        └──────────────────────┘
        ▲                        │
        │                        │ Prisma
        └────── graph CRUD ──────┘
```
Three concerns, deliberately separated:
Engine — owns the DAG, subscribes to inputs, computes, writes outputs to KV
KV — the source of truth for current values; survives engine restarts
WS Gateway — reads KV watches, fans out to browsers; knows nothing about the graph
Engine and WS Gateway can run in the same Fastify process initially; split later if needed.
4. Core concepts
4.1 Node vs Property
A Node is a named bundle. It groups related properties under one identity (e.g., `Press7`, `Workcenter A`, `Site Sarasota`). A node has no resolver of its own, but it may be bound to an entity instance (see §4.6) — which is how the asset hierarchy projects into the graph.
A Property is the addressable unit of computation. Each property:
Belongs to exactly one node
Has a resolver (tag, entity, expr, window, or rollup)
Produces a value envelope
Can be referenced by other properties' expressions
Can be subscribed to independently by clients
"Scalar nodes" are nodes with a single property (conventionally named `value`). The engine doesn't distinguish them — it's a UI presentation choice.
Object-valued properties are allowed: a property's envelope can carry an object as its `value`. The object's fields are opaque to the engine — not independently watchable, not part of the DAG. If you want field-level reactivity, model each field as its own property.
4.2 Value envelope
Every property produces and consumes this shape. No exceptions:
```ts
type Quality = 'good' | 'stale' | 'uncertain' | 'bad';

interface ValueEnvelope {
  value: unknown;        // primitive or object
  quality: Quality;
  timestamp: number;     // unix ms
  context?: Record<string, unknown>;  // optional, opaque to engine
}
```
Uniformity matters: `expr` properties must compose any input regardless of source.
4.3 Resolver — discriminated union
```ts
type Aggregation = 'avg' | 'sum' | 'count' | 'min' | 'max';

type Resolver =
  | { type: 'tag';     deviceId: string; tagPath: string }
  | { type: 'entity';  entity: string;                   // system model OR user-defined type name
                       backend?: 'prisma' | 'jsonb';      // optional; engine resolves via catalog if absent
                       id: string;
                       path: string }                     // Prisma field/relation path, OR JSONB key for user types
  | { type: 'metric';  granularity: string;               // MetricBucket granularity, e.g. 'SHIFT'
                       metricKey: string }                 // MetricBucket column, e.g. 'goodItems'
  | { type: 'expr';    expression: string }
  | { type: 'window';  sourcePropertyId: string;
                       kind: 'tumbling' | 'ewma';
                       aggregation: Aggregation;          // tumbling only; ignored for ewma
                       windowMs?: number;                 // tumbling only, required
                       alignToMs?: number;                // tumbling only, default 0 (epoch)
                       alpha?: number;                    // ewma only, 0 < alpha <= 1
                     }
  | { type: 'rollup';  childKind: string;                 // node kind to aggregate, e.g. 'Station'
                       relation: string;                  // Prisma relation name to children, e.g. 'stations'
                       childProperty: string;             // property name on each child, e.g. 'oee'
                       aggregation: Aggregation;
                       weightBy?: string;                 // optional child property to weight avg by
                     };
```
tag — subscribes to a NATS subject derived from `deviceId` + `tagPath`
entity — reads a property from an entity instance, refreshed on domain events. The instance may be a system entity (Prisma model) or a user-defined entity (JSONB store, §5.1). For Prisma the `path` is a field/relation path; for user-defined types it's a key into the JSONB `values`. The engine picks the backend from the catalog.
metric — mirrors a worker-computed `MetricBucket` value for the node's bound entity at a granularity. Push-fed over NATS by the metric bridge (subject `metrics.<entityId>.<granularity>.<metricKey>`). The entity id comes from the node binding (§4.6), so the resolver config is static per kind — the same config materializes on every Station. Full design in §4.7.
expr — evaluated via mathjs; dependencies extracted by parsing the expression
window — time-windowed aggregation over one source property (tumbling / event-driven EWMA). Full design in §17.
rollup — structural aggregation over a node's child assets in the asset hierarchy. Aggregates `childProperty` across all children of `childKind` reachable via `relation`. Full design in §18. This is the spatial analog of `window`: where `window` aggregates one property over time, `rollup` aggregates one property over a set of child nodes.
Dependencies for `expr` properties are derived from the expression. Dependencies for `window` properties are the single `sourcePropertyId`. Dependencies for `rollup` properties are dynamic — the current set of children — and are rebuilt on membership change, not just on save (see §18.3).
4.4 Identity & addressing
Every property has a stable UUID. Other properties reference it by UUID, not by name — so renaming `Press7.cycleTime` → `Press7.cycle_time_seconds` doesn't break any expressions.
User-facing display uses `<NodeName>.<PropertyName>`; the engine sees property UUIDs throughout. The save endpoint translates between the two.
4.5 Node, Property, DAG
```ts
interface Node {
  id: string;
  name: string;
  kind?: string;                 // template/type label, e.g. "Station", "Workcenter", "Site"
  entityType?: string;           // if entity-backed: the Prisma model, e.g. "Station"
  entityId?: string;             // if entity-backed: the instance id
  properties: Property[];        // owned
}

interface Property {
  id: string;                    // ULID/CUID, stable
  nodeId: string;
  name: string;                  // unique within node
  resolver: Resolver;
  current: ValueEnvelope;
  compiled?: object;             // mathjs AST cache for expr properties
  sampleRateMs?: number;         // optional throttle for expensive exprs
}
```
The DAG is at the property level. Edges go from input property → dependent property. Two adjacency maps:
`dependents: Map<propertyId, Set<propertyId>>` — forward propagation
`dependencies: Map<propertyId, Set<propertyId>>` — for evaluation, walking inputs
Two properties on the same node can reference each other (no cycle required — they just share a parent). Cycles between properties are rejected at save time regardless of node membership.
4.6 Asset hierarchy & entity-backed nodes
Rockware's asset model is `Site → Workcenter → Station` (ISA-95 equipment hierarchy). This projects into the graph directly: each level is an entity-backed node kind.
Entity-backed node. A node with `entityType` + `entityId` set is bound to a specific Prisma entity instance. `Station` node `Press7` has `entityType: 'Station', entityId: 'station_7'`. Its entity-typed properties read from that instance automatically; the binding lives at the node level (resolving the §18 / former open question), so all of a node's entity properties point at the same instance, and the node's relations are the tree edges.
Node kinds. `kind` is the template label — `Site`, `Workcenter`, `Station`. All nodes of a kind share the same property schema (every Station has `oee`, `partsThisShift`, `cycleTime`, …). This is what makes dashboard repeaters and rollups work uniformly: `$station.oee` resolves identically across every Station because the kind guarantees the property exists. v1 implements kinds as a label plus a property-set convention; full template inheritance (define once, auto-instantiate per entity) is a fast-follow (see §15).
The tree comes from Prisma relations, not the graph. The graph does not store parent/child edges between nodes. It reads them from the entity relations: `Station.workcenterId → Workcenter`, `Workcenter.siteId → Site`. The graph engine queries these relations to resolve rollups (aggregate children) and the dashboard layer queries them to resolve collections (repeat over children). One source of truth for structure: the domain model.
Two directions of dataflow over the same tree:
Up — rollup aggregation. A parent's KPI is an aggregate of its children. `Workcenter.oee` = weighted avg of its stations' `oee`. `Site.oee` = aggregate of its workcenters. The `rollup` resolver (§18).
Down — dashboard repeaters. A dashboard scoped to a level renders one tile per child. Site overview repeats over workcenters; a workcenter screen repeats over stations. This is a consumption-layer concern (§9 / dashboard workstream), not an engine resolver — but it relies on the same Prisma relations.
Data catalog. The API entity service exposes data definitions from `ObjectSchema`, not from LiveStore boot reflection. System records such as `Site`, `Workcenter`, and `Station` are projected into system `ObjectSchema` rows (`source = RECORD`), while user-authored documents use workspace `ObjectSchema` rows (`source = DOCUMENT`) backed by `ObjectInstance`.
The editor's property picker autocompletes from this data catalog — nobody hand-types field names. The `entity` resolver dispatches to the right backend (`record` vs JSONB document lookup) based on the schema source; everything downstream (projection to nodes, expressions, dashboards) is identical regardless of origin. Relations in record schema fields drive the kind→children traversal for rollups, while document schemas remain standalone unless a future relation model is added.
A declared metric layer (§4.7) still supplies live KPI fields and materialized graph properties that are computed outside ordinary object field storage.
4.7 Metric mirror — worker-computed KPIs (`metric` resolver)
The platform already computes shift KPIs outside the graph: the metrics worker folds raw point data into `MetricBucket` rows, applying shift calendars, planned/unplanned downtime classification, expected cycles from standards, and job context. That logic is not expressible as graph windows, and reimplementing it would fork the numbers — graph dashboards disagreeing with existing reports is the worst failure mode available. So the graph consumes it and never recomputes it.
Dataflow:
The worker's metric bus dual-publishes every bucket change to NATS via the graph bridge (`packages/services/src/metrics/graph-nats-bridge.ts`). Only STATION SHIFT additive counters are bridged.
Each Station node carries one `metric` property per additive counter (`shift_goodItems`, `shift_runSeconds`, …) — push-fed leaves, mechanically identical to tag subscriptions but with instance-relative addressing (the entityId comes from the node binding, so one resolver config serves every Station).
Workcenter and Site carry the same properties as `rollup { aggregation: 'sum' }` over their children — extensive quantities, so summing is correct.
Ratios (`oee`, `availability`, `performance`, `quality`) are never mirrored and never summed; they are `expr` properties over the summed components at each level, so every level's ratio is intensive-correct.
Metric catalog. DMMF reflection can't tell which `MetricBucket` columns belong to which kind — the table is polymorphic (an `(entityType, entityId)` discriminator, no typed relations to follow). A declared catalog (`metricCatalog.ts`) supplies that layer: each field's role (additive / ratio / display), units, applicable kinds, and ratio formulas. It is the single source of truth for the pickable KPI set — node-sync materializes properties from it and the API data catalog can expose it to the picker, so the two can't drift. A boot assertion reconciles it against the live `MetricBucket` schema: an unclassified column, or a declared field with no backing column, fails the boot.
Division of labor with `window`: the OEE/shift-counter family comes from the mirror; `window` remains for ad-hoc time aggregation the worker doesn't compute (smoothed cycle time via EWMA, alarms/hour over a raw tag).
5. Data model (Prisma)
```prisma
model GraphNode {
  id         String          @id @default(cuid())
  name       String          @unique
  kind       String?         // 'Site' | 'Workcenter' | 'Station' | ...
  entityType String?         // if entity-backed: Prisma model name
  entityId   String?         // if entity-backed: instance id
  isDeleted  Boolean         @default(false)
  createdAt  DateTime        @default(now())
  updatedAt  DateTime        @updatedAt
  properties GraphProperty[]

  @@unique([entityType, entityId])   // one node per entity instance
  @@index([kind])
  @@index([isDeleted])
}

model GraphProperty {
  id            String   @id @default(cuid())
  nodeId        String
  node          GraphNode @relation(fields: [nodeId], references: [id])
  name          String
  resolverType  String   // 'tag' | 'entity' | 'metric' | 'expr' | 'window' | 'rollup'
  resolver      Json     // discriminated union payload
  sampleRateMs  Int?
  isDeleted     Boolean  @default(false)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  edgesIn       GraphEdge[] @relation("ToProperty")
  edgesOut      GraphEdge[] @relation("FromProperty")

  @@unique([nodeId, name])
  @@index([resolverType])
  @@index([isDeleted])
}

model GraphEdge {
  id             String        @id @default(cuid())
  fromPropertyId String
  toPropertyId   String
  fromProperty   GraphProperty @relation("FromProperty", fields: [fromPropertyId], references: [id])
  toProperty     GraphProperty @relation("ToProperty",   fields: [toPropertyId],   references: [id])
  createdAt      DateTime      @default(now())

  @@unique([fromPropertyId, toPropertyId])
  @@index([fromPropertyId])
  @@index([toPropertyId])
}
```
Soft-delete only. `GraphEdge` is rebuilt on every property save — for `expr` from the parsed expression, for `window` from `resolver.sourcePropertyId` (one edge). For `rollup`, edges are not persisted in `GraphEdge` because the child set is dynamic; the engine maintains rollup dependencies in memory and refreshes them on membership change (§18.3). `GraphEdge` remains the authority for static (expr/window) dependencies and cycle checking.
Property names are unique within a node, not globally. `Press7.cycleTime` and `Press8.cycleTime` coexist.
Aggregation state is not in Postgres. Tumbling/EWMA state lives in the `imm_agg_state` NATS KV bucket (see §6 and §17.4). Rollup output is just a property value in `imm_cvt` like any other; rollups hold no durable accumulator state (they recompute from current child values). Postgres holds only property definitions. This keeps Prisma schemas stable and avoids hot-write traffic to Postgres on every input event.
5.1 User-defined entity store
A separate tier for entity types users define in the UI. Standalone in v1 — no relations to system entities or to each other (drops referential integrity, orphan handling, and cascade semantics entirely). JSONB-backed, validated on write, projected into the graph exactly like system entities.
```prisma
model EntityType {                    // user defines this in the UI
  id          String         @id @default(cuid())
  name        String         @unique  // "Mold Spec", "Inspection Record"
  properties  PropertyDef[]
  instances   EntityInstance[]
  isDeleted   Boolean        @default(false)
  createdAt   DateTime       @default(now())
}

model PropertyDef {
  id           String     @id @default(cuid())
  entityTypeId String
  entityType   EntityType @relation(fields: [entityTypeId], references: [id])
  name         String
  type         String     // 'text' | 'number' | 'boolean' | 'select' | 'date'
  config       Json?      // e.g. select options, number precision
  required     Boolean    @default(false)
  @@unique([entityTypeId, name])
}

model EntityInstance {
  id           String     @id @default(cuid())
  entityTypeId String
  entityType   EntityType @relation(fields: [entityTypeId], references: [id])
  values       Json       // { "durometer": 60, "material": "EPDM", ... }
  isDeleted    Boolean    @default(false)
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
  @@index([entityTypeId])
  @@index([entityTypeId, isDeleted])
}
```
Notes:
Property types are scalar only in v1: `text`, `number`, `boolean`, `select`, `date`. No `relation` type (standalone), no `formula` type (overlaps the `expr` resolver — deferred to avoid coupling two big systems; see §15).
Validation: generate a Zod schema from a type's `PropertyDef` rows and validate `values` on every write. Reject unknown keys and type mismatches at the API boundary.
JSONB querying: GIN-index `values` if users need to filter instances by property. Adequate for the cool, low-churn long tail this tier targets; never put PLC-fed or high-frequency data here (that's the system tier).
Projection: an `EntityInstance` can back a graph node (`entityType` = the user type name, `entityId` = instance id). Its properties use the `entity` resolver with `backend: 'jsonb'`. Standalone → not a rollup child, but referenceable in expressions and on dashboards.
Domain events: user-entity mutations emit a domain event (e.g. `userentity.changed`) on the same bus (§8.2) so projected node properties refresh — identical mechanism to system entities.
The entity-designer UI and this store are largely a parallel workstream from the graph engine. The graph-side impact is small: two-source the catalog (§4.6) and dispatch the `entity` resolver by backend. Everything else is entity-management, not graph compute.
6. NATS KV layout
Two KV buckets:
6.1 `imm_cvt` — current value table
Key format: `prop.<propertyId>` — flat namespace, one entry per property.
Why not `node.<nodeId>.<propertyName>`: property IDs are stable across renames, names aren't. Watching by ID is also faster than wildcard-watching by name pattern.
Value: JSON-serialized `ValueEnvelope`.
Configuration:
History: 5 revisions (enough for the WS gateway to handle reconnect gaps)
Max value size: 64 KB (object-valued properties can be large; size accordingly)
TTL: none (values persist; staleness is communicated via `quality`)
Watch patterns:
Engine on startup: `kv.watch("prop.>")` with current-state to seed values
WS gateway per client: `kv.watch("prop.<propertyId>")` per subscribed property, multiplexed
6.2 `imm_agg_state` — aggregation state
Internal to the engine. Not exposed to the WS gateway or clients.
Key format: `agg.<propertyId>` — one entry per `window` property.
Value: JSON-serialized aggregation state (schema by kind — see §17.4).
Configuration:
History: 1 revision (last-write-wins recovery is sufficient)
Max value size: 16 KB (tumbling/EWMA state is tiny; safety margin)
TTL: none
Only the engine reads/writes this bucket. State updates are debounced to ~500ms cadence per property to avoid hammering KV on high-rate inputs (see §17.7).
7. Expression syntax
Two forms exist:
User-facing (what the editor accepts and displays):
```
Press7.cycleTime * Press7.cavityCount / 60
```
Stored / internal (what gets persisted and evaluated):
```
p_01HXYZABCD * p_01HXYZWXYZ / 60
```
The save endpoint resolves `NodeName.propertyName` references to property UUIDs and stores the internal form. On read, it converts back for the editor. The mathjs parser sees only `p_<id>` symbols.
This is the same pattern Excel uses (display `Sales!A1`, internal cell reference). It makes renames safe and decouples expression durability from naming.
Dependency extraction (after compile):
```ts
function compileExpression(expr: string): { ast: object; deps: Set<string> } {
  const ast = mathjs.parse(expr);
  const deps = new Set<string>();
  ast.traverse(node => {
    if (node.isSymbolNode && node.name.startsWith('p_')) {
      deps.add(node.name.slice(2));  // strip 'p_' prefix
    }
  });
  return { ast, deps };
}
```
Field access on object-valued properties uses normal mathjs syntax: `p_<id>.fieldName`. The engine doesn't track the field — it's just a property access on the resolved value at evaluation time.
8. Engine implementation
8.0 Two schedulers (architectural note)
The engine has two scheduling mechanisms. Both are real in v1:
Input-driven tick (50ms coalescing) — propagates dirty-set from incoming NATS messages and entity events through expression dependents. See §8.4.
Bucket close timers (per tumbling window property) — each active tumbling bucket schedules a `setTimeout` to fire at its close timestamp. On fire: emit the closed bucket, open the next, schedule its close. No general 1Hz loop required because EWMA is event-driven and sliding windows are out of scope.
The flush loop dispatches on `resolverType`. In v1, both `expr` and `window` produce computed output (`tag`, `entity`, and `metric` properties get their values from subscriptions). Build the dispatch as an explicit switch (or registry) so future resolver kinds slot in cleanly.
A general time-driven tick (~1Hz across the whole engine) is deferred to v2, alongside sliding windows. The bucket-timer approach scales fine for tumbling alone; thousands of active timers in Node.js is unremarkable.
8.1 Lifecycle
```
boot()
  ├── connect to NATS + open KV bucket
  ├── load all GraphNode + GraphProperty rows from Postgres
  ├── build dependents/dependencies maps from GraphEdge
  ├── compile all expr properties (parse mathjs AST, cache)
  ├── seed current values from KV (one pass over kv.watch with current-state)
  ├── subscribe to NATS subjects for all tag properties
  ├── subscribe to entity event bus for all entity properties
  ├── mark all expr properties dirty (recompute against seeded inputs)
  └── start tick scheduler
```
8.2 Input subscriptions
Tag properties — group by NATS subject so we don't open one subscription per property. Maintain `Map<natsSubject, Set<propertyId>>`. On message arrival:
Parse payload into `ValueEnvelope` (Edge already publishes in compatible shape; coerce if not)
For each property in the set, write to `property.current`
Add all `dependents.get(propertyId)` to `dirty`
(Tick scheduler picks it up)
Metric properties — same subscription mechanics as tags, grouped by subject (`metrics.<entityId>.<granularity>.<metricKey>`). Subjects derive from the shared convention in `@rw/runtime/graph-subjects` on both the producer (worker bridge) and consumer (engine) side, so the two can't disagree.
Entity properties — subscribe to a single NATS subject `domain.events.>` published by Fastify on entity mutation. Event shape:
```ts
{ entity: 'Job', id: 'job_123', changedFields: ['status', 'targetCycleTime'], timestamp }
```
On event, find all entity properties matching `(entity, id)` whose `path` is `*` or in `changedFields`. Re-fetch via Prisma, update `current`, mark dependents dirty.
8.3 Save flow (cycle check happens here)
```
saveProperty(input):
  1. validate: property name unique within node
  2. parse resolver
  3. if expr:
       - translate "NodeName.propName" refs to "p_<id>" symbols
       - compile expression, extract deps -> depSet
  4. build hypothetical adjacency including new property
  5. run cycle detection (DFS, color marking)
     - if cycle: reject with 400 + cycle path in human-readable form
  6. transaction:
       - upsert GraphProperty
       - delete GraphEdge where toPropertyId = property.id
       - insert GraphEdge for each dep
  7. notify engine to hot-reload that property
```
A property may freely depend on other properties of the same node. The cycle check operates on property IDs and is agnostic to node membership.
8.4 Dirty tracking & tick
```ts
private dirty = new Set<string>();           // property IDs
private flushScheduled = false;

markDirty(propertyId: string) {
  const stack = [propertyId];
  while (stack.length) {
    const id = stack.pop()!;
    if (this.dirty.has(id)) continue;
    this.dirty.add(id);
    for (const dep of this.dependents.get(id) ?? []) stack.push(dep);
  }
  if (!this.flushScheduled) {
    this.flushScheduled = true;
    setTimeout(() => this.flush(), TICK_MS);  // TICK_MS = 50
  }
}
```
Coalescing window: 50ms default, tunable. A 10Hz tag firing into a deep graph still triggers only one evaluation pass per 50ms window.
8.5 Flush — the evaluation pass
```
flush():
  1. dirtyList = Array.from(this.dirty); this.dirty.clear()
  2. flushScheduled = false
  3. topo-sort dirtyList using dependencies map (Kahn's algorithm restricted to dirtyList)
  4. for each property in topo order:
       - if property.resolver.type !== 'expr': skip (current is already up to date)
       - else: evaluate
  5. for each property whose value changed: kv.put("prop." + id, JSON.stringify(envelope))
```
8.6 Expression evaluation
```ts
function evaluateExpr(prop: Property): ValueEnvelope {
  const scope: Record<string, unknown> = {};
  let worstQuality: Quality = 'good';
  let latestInputTs = 0;

  for (const depId of this.dependencies.get(prop.id) ?? []) {
    const dep = this.properties.get(depId);
    if (!dep) return errorEnvelope('missing dependency');
    scope[`p_${depId}`] = dep.current.value;
    worstQuality = worse(worstQuality, dep.current.quality);
    latestInputTs = Math.max(latestInputTs, dep.current.timestamp);
  }

  try {
    const value = prop.compiled.evaluate(scope);
    return {
      value,
      quality: worstQuality,
      timestamp: Date.now(),
      context: { computedFrom: latestInputTs }
    };
  } catch (e) {
    return { value: null, quality: 'bad', timestamp: Date.now(), context: { error: e.message } };
  }
}
```
Quality propagation: the worst of all inputs. One stale input → stale output. Conservative and correct.
8.7 Sandboxing mathjs
The internal mathjs wrapper must:
Disable `import`, `createUnit`, dynamic `evaluate` of strings inside expressions
Disable `Function`, `eval` constructors
Restrict function whitelist (arithmetic, comparison, basic math, no `import`/`eval`/`parse`)
Set evaluation timeout (~100ms ceiling per property)
Limit expression length at save time (e.g., 2000 chars)
Reference: mathjs `import` with `{ wrap: true, override: false }` and explicit function list.
8.8 Cycle detection (save-time)
Standard DFS with white/gray/black coloring on the hypothetical post-save adjacency. On hitting a gray property, walk parents to produce a readable cycle path:
```
"Cannot save: cycle detected
  Press7.efficiency → Line2.throughput → Press7.cycleTime → Press7.efficiency"
```
8.9 Throttling expensive properties
`sampleRateMs` caps how often an expr property is evaluated, regardless of input churn:
```ts
if (prop.resolver.type === 'expr' && prop.sampleRateMs) {
  const sinceLast = Date.now() - prop.current.timestamp;
  if (sinceLast < prop.sampleRateMs) {
    setTimeout(() => this.markDirty(prop.id), prop.sampleRateMs - sinceLast);
    continue;
  }
}
```
Default unset = recompute every tick when dirty.
8.10 Rollup evaluation (summary; full design §18)
`rollup` properties evaluate in the same flush loop as `expr`, dispatched on `resolverType`. The difference is dependency resolution: instead of a fixed input set, a rollup reads the current children of its node (via the entity relation) and aggregates `childProperty` across them. The engine keeps an in-memory `Map<rollupPropertyId, Set<childPropertyId>>` refreshed whenever (a) a child value changes — rides the normal dirty mechanism — or (b) membership changes — a new event type on the domain bus. See §18 for the full design, including weighted aggregation and dynamic-membership handling.
9. WebSocket gateway
Fastify route `/ws/graph` using `@fastify/websocket`.
9.1 Protocol
Subscriptions are per property, not per node. To subscribe to a whole node, the client subscribes to each of its properties (the editor can do this on the user's behalf when they pick a node).
Client → server:
```json
{ "op": "subscribe",   "propertyIds": ["abc", "def"] }
{ "op": "unsubscribe", "propertyIds": ["abc"] }
```
Server → client (initial value on subscribe + every update):
```json
{
  "op": "value",
  "propertyId": "abc",
  "envelope": { "value": 18.2, "quality": "good", "timestamp": 1730000000000 }
}
```
9.2 Per-connection state
```ts
interface Connection {
  ws: WebSocket;
  subscribed: Map<string, KvWatcher>;  // propertyId -> watch handle
}
```
On `subscribe`: `kv.get(key)` for initial value, send, then `kv.watch(key)` and pipe updates. On `unsubscribe` or disconnect: stop watchers.
9.3 Backpressure
If `ws.bufferedAmount` exceeds a threshold (e.g., 1 MB), drop intermediate updates and send only the latest per property when the buffer drains. Critical for slow clients on factory wifi.
10. REST API (Fastify routes)
Minimum surface for the graph editor UI:
Method	Path	Purpose
GET	`/graph/nodes`	List nodes with their properties (paginated)
GET	`/graph/nodes/:id`	Get one node + properties + current values
POST	`/graph/nodes`	Create node (no properties yet, or properties inline)
PUT	`/graph/nodes/:id`	Update node metadata
DELETE	`/graph/nodes/:id`	Soft-delete (cascades to properties; warns on external dependents)
POST	`/graph/nodes/:id/properties`	Add a property (runs cycle check)
PUT	`/graph/properties/:id`	Update a property (runs cycle check)
DELETE	`/graph/properties/:id`	Soft-delete a property (warns on dependents)
POST	`/graph/validate`	Dry-run a property config; returns parsed deps + cycle check, no persistence
GET	`/graph/properties/:id/dependents`	What breaks if I delete this?
GET	`entity.catalog.list/get`	Data catalog from `ObjectSchema`: record/document definitions, fields, and relations for the editor's property picker
GET	`/graph/nodes/:id/children?kind=Station`	Resolve children of a node by kind/relation (powers rollups and dashboard repeaters)
GET	`/graph/collections?kind=Station&scope=Workcenter:wc_a`	Resolve a collection: nodes of a kind filtered by hierarchy scope (dashboard repeater binding)
All write routes emit an event the engine subscribes to for hot-reload. The `children` and `collections` endpoints are read-only projections over entity relations — the same traversal the rollup resolver uses internally (§18.8).
11. Bootstrap & restart behavior
The engine is stateless across restarts in the sense that:
Graph structure rebuilds from Postgres on every boot
Current values rebuild from NATS KV (last known per property)
Recomputation resumes naturally as new NATS messages arrive
Initial quality on boot is `stale` for every property — bumps to `good` as fresh data flows in. Dashboards should render stale values dimmed or annotated.
Recovery time: low-single-digit seconds for graphs up to ~10k properties.
12. Single-process constraint
Only one engine instance writes to the KV bucket at a time. For single-tenant Fly.io, this is one machine running the engine. If HA becomes a requirement later:
Leader election via NATS KV CAS on a `leader` key with TTL heartbeat
Standby keeps a warm DAG but doesn't write to KV until it acquires leadership
WS gateway scales horizontally independently (read-only watchers)
Do not attempt to shard the graph across processes. Pin it to one.
13. Observability
Per-property metrics: evaluations/sec, last-eval duration, error count, quality distribution
Engine metrics: dirty-set size at flush, flush duration, tick lag, NATS subscription count, KV write rate
Tracing: OTEL spans around `flush()` and individual evaluations over a duration threshold
Structured logging: Pino, with `propertyId`, `nodeId`, `resolverType`, `quality` as standard fields
Slow-expression log threshold: 50ms eval time
14. Security
Expression sandbox per §8.7 — non-negotiable
REST endpoints behind existing Rockware auth
WS subscribe authorizes the user can see the requested properties (single-tenant: any authed user can see all; bake the check in for future-proofing)
No raw NATS subject exposure to the browser
Audit log on graph CRUD (who created/edited/deleted which node or property)
15. Out of scope for v1
Versioning / draft-vs-published graphs
Branching expressions beyond `?:`
Sliding windows (rolling avg/min/max over a moving N-minute window) — needs per-property sample buffers, continuous re-emit, and a general 1Hz scheduler. Deferred. Users wanting "recent average" use EWMA in v1.
Aggregation functions beyond avg / sum / count / min / max — no `stddev`, no `last`, no `percentile`. Add as demand emerges; once shipped they're forever.
Counter as a distinct kind — shift production counters come from the metric mirror (§4.7), not from windows; a tumbling window with `aggregation: 'count'` covers ad-hoc event tallies. A general counter-with-arbitrary-reset (rising-edge, cron schedules) is deferred.
Metric mirror beyond STATION SHIFT additive counters — other granularities (HOUR, DAY), display-only fields (`currentStandardCycle`), and bridging non-station buckets are deferred. The graph derives workcenter/site numbers from station leaves itself; bridging the worker's own workcenter/site buckets would create two sources for the same number.
Time-decaying EWMA — v1 EWMA is event-driven only; output updates when input arrives, not on the clock. Decay-on-quiet-input is deferred.
Edge detection (rising/falling transitions as a primitive)
Full node-kind templates — v1 ships kinds as a label + property-set convention (enough for rollups and repeaters to resolve uniformly). Auto-instantiation (define a "Station" template once, materialize a node for every Station entity automatically, propagate property edits to all instances) is a fast-follow. v1 nodes are created explicitly or via a one-time sync from existing entities.
Rollup depth beyond 3 levels — Site → Workcenter → Station is two hops. Cap rollup chains there; deeper hierarchies deferred.
User-defined entity relations — v1 user-defined entities (§5.1) are standalone. Relations (user→system, user→user) bring referential integrity, orphan handling, and cascade semantics — deferred. Standalone user entities also can't be rollup children (no relation to traverse).
User-defined `formula` and `relation` property types — `formula` overlaps the `expr` resolver (don't couple the two systems yet); `relation` is deferred with relations generally. v1 user property types are scalar: text, number, boolean, select, date.
User-defined entity views / filtered collections — the no-code "database view" layer (saved filters, sorts, grouped displays) is a UI feature, deferred.
Cross-graph references / sub-graphs
Visual graph + dashboard editors — REST API + JSON suffices for v1; UI is a separate workstream. The dashboard repeater (bind collection → render template per child) is a consumption-layer feature that depends on the §18 primitives but is built in the UI workstream.
Multi-instance HA
16. Implementation milestones
M1 — Foundations (1 week)
Prisma schema + migrations (Node with entity binding, Property, Edge)
NATS KV bucket setup: `imm_cvt` for current values, `imm_agg_state` for tumbling/EWMA state
Engine skeleton: in-memory `Map<id, Property>` + `Map<id, Node>`, no resolvers yet
Boot from Postgres + seed from KV
Resolver dispatch as explicit switch/registry
ObjectSchema-backed data catalog served by the API entity service
Health endpoint
M2 — Tag resolver (1 week)
NATS subscription manager grouped by subject
Tag property end-to-end: NATS in → KV out
WS gateway with subscribe/unsubscribe at property level
Simple test harness: publish to NATS, verify dashboard updates
M3 — Expression resolver (2 weeks)
mathjs wrapper integration + sandbox
Bidirectional translation: `NodeName.propName` ↔ `p_<id>`
Expression parser + dependency extractor
Cycle detection across properties
Dirty tracking + topo-sort flush
Quality propagation
Object-valued properties + field access
M4 — Entity resolver + asset hierarchy (2 weeks)
Domain event publisher in Fastify mutation handlers (`Job`, `Tool`, `Recipe`, `Station`, `Workcenter`, `Site`)
Entity subscription manager; entity-backed nodes (`recordId` for records, `documentId` for documents)
One-time sync: materialize a node per existing Station/Workcenter/Site instance
Relation-aware re-fetch: change to an instance marks dependent properties dirty
Membership events (`asset.moved`: a Station's workcenter changed) on the domain bus
Project system records into `ObjectSchema` and dispatch the `entity` resolver by backend (`record` vs JSONB document). The data catalog is owned by the API entity service.
M5 — Window resolver: tumbling + EWMA (2 weeks)
`imm_agg_state` KV bucket integration
Tumbling: bucket lifecycle, incremental `count/sum/min/max`, derived `avg`, `setTimeout` close scheduling, `alignToMs` offset
EWMA: event-driven update, alpha validation, state persistence
Restart handling: rehydrate state, fast-forward missed bucket closes
Quality propagation; save-endpoint validation
See §17 for full design
M6 — Rollup resolver: structural aggregation (2 weeks)
In-memory `Map<rollupPropertyId, Set<childPropertyId>>` membership index
Resolve children via entity relation (`childKind` + `relation`)
Aggregation incl. weighted avg (`weightBy`)
Two invalidation triggers: child value change (existing dirty path) + membership change (`asset.moved` event → rebuild that rollup's child set, mark dirty)
Rollup-of-rollups (Site aggregates Workcenter aggregates Station), depth cap = 3
Quality propagation: worst child quality + coverage (missing children → uncertain)
See §18 for full design
M7 — Polish (1 week)
REST CRUD for nodes and properties with cycle + depth validation
WS backpressure handling
Sample-rate throttling
Metrics + Pino structured logs (`agg.bucket_closes`, `agg.late_samples_dropped`, `rollup.membership_rebuilds`)
Load test: 5k properties, 1k tags @ 5Hz, 200 windows, plus a Site/Workcenter/Station tree with rollups; measure flush + bucket jitter + rollup recompute on membership change
Realistic total: ~11 weeks for one engineer on the graph engine, less if pairing. M4 grew to 2 weeks for the hierarchy + catalog two-sourcing.
Parallel workstream (not in the graph-engine estimate): the user-defined entity store + designer UI (§5.1) — `EntityType`/`PropertyDef`/`EntityInstance` tables, Zod-from-config validation, CRUD API, and the Notion-style schema-designer UI. Standalone-only scope keeps this bounded (~2–3 weeks for the store + API; the designer UI is its own effort). The graph engine only needs the M4 hooks to consume its catalog output, so the two workstreams can proceed independently as long as the catalog contract is agreed early.
17. Time-based aggregations (`window` resolver)
This section specifies the v1 implementation of the `window` resolver. Tumbling and event-driven EWMA only; sliding windows and counter-with-arbitrary-reset are deferred per §15.
17.1 Why aggregations are not just expressions
Three structural differences from `expr` justify a separate resolver type:
Stateful. A tumbling bucket carries running `count/sum/min/max`. An EWMA carries the previous value. Expressions are pure functions of current inputs.
Time-driven (tumbling). A tumbling bucket has to emit when its window closes, regardless of input arrival. The 50ms input-driven flush has no notion of "fire because time passed." We solve this with per-bucket `setTimeout`, not a general scheduler.
History-dependent across restarts. Restart loses in-memory state unless persisted separately from the current output envelope.
These differences make aggregations a separate evaluator, not a mathjs function.
17.2 Patterns in v1 (and what's deferred)
Pattern	v1?	Storage	Typical use
Tumbling	✅ yes	O(1) — current bucket only	Parts/shift, alarms/hour, hourly throughput
EWMA (event-driven)	✅ yes	O(1)	Smoothed cycle-time trend, filtered setpoints
Sliding window	❌ deferred	O(samples)	Recent rolling average (use EWMA in v1)
Counter with arbitrary reset	❌ deferred	O(1)	Same as tumbling-count for v1; deferred = cron resets, rising-edge increments
Time-decaying EWMA	❌ deferred	O(1)	EWMA that decays without inputs
17.3 Resolver shape
```ts
{ type: 'window';
  sourcePropertyId: string;                // exactly one input
  kind: 'tumbling' | 'ewma';
  aggregation: 'avg' | 'sum' | 'count' | 'min' | 'max';   // tumbling; ignored for ewma
  windowMs?: number;                       // tumbling, required
  alignToMs?: number;                      // tumbling, default 0 (epoch)
  alpha?: number;                          // ewma, required, 0 < alpha <= 1
}
```
Validation at save time:
`sourcePropertyId` exists and is not a `window` property (no chained aggregations in v1)
`kind = tumbling`: `windowMs >= 1000` (1s minimum to prevent abuse), `aggregation` is one of the five
`kind = ewma`: `alpha` is in `(0, 1]`
Cycle check still applies (the source property must not transitively depend on this one)
Bucket alignment example. For shift boundaries: `windowMs = 8 * 60 * 60 * 1000` (8h), `alignToMs = <epoch ms of any shift start>` (e.g., 6am on Jan 1, 2025 UTC in the customer's timezone). Buckets align to that anchor: each bucket starts at `alignToMs + n * windowMs` for some integer `n`. For midnight-aligned day buckets, `alignToMs = 0` is fine if the timezone is UTC; otherwise set it to local midnight on a reference date.
17.4 State storage
A second KV bucket: `imm_agg_state`, key `agg.<propertyId>`. JSON value, schema by kind:
```ts
// tumbling
{ kind: 'tumbling';
  bucketStart: number;        // ms, inclusive
  bucketEnd: number;          // ms, exclusive (== bucketStart + windowMs)
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  goodCount: number;          // samples with quality 'good' (for quality output)
  totalCount: number;         // samples seen (incl. non-good)
}

// ewma
{ kind: 'ewma';
  value: number;
  lastInputTs: number;        // ms, for staleness reporting
  lastInputQuality: Quality;
}
```
Separate bucket from `imm_cvt` because:
State updates much more often than output (every input, vs. once per close for tumbling)
State schema is internal — should not be exposed to WS clients
KV history settings differ: 1 revision is enough for state (last-write-wins recovery); `imm_cvt` keeps 5 for reconnect handling
Configuration: max value size 16 KB (tumbling state is tiny; this is just a safety margin), no TTL.
17.5 Engine integration
Add a `WindowEvaluator` module alongside the existing tag/entity/expr handling. New responsibilities on the engine:
Boot (extending §8.1):
Load all `window` properties
For each, rehydrate state from `imm_agg_state`
For tumbling: if `now > bucketEnd`, fast-forward: emit the last bucket with `quality: 'stale'`, then a single gap marker (`count: 0, quality: 'bad', context.gapBuckets: N`) when buckets were skipped, then open the current-time bucket (see §17.8)
For tumbling: schedule `setTimeout` for the current bucket's close at `bucketEnd - now`
Subscribe to source property updates (subscribing means: register this window in the dependents map keyed on `sourcePropertyId`)
On source property update (extending §8.4):
The engine already updates dependents when an input changes. For window properties, the "update" path runs `WindowEvaluator.onInput(property, newValue)` instead of marking dirty for expression evaluation.
```ts
// Pseudocode
onInput(prop: WindowProperty, input: ValueEnvelope) {
  const state = this.aggStateCache.get(prop.id);
  if (prop.resolver.kind === 'tumbling') {
    // Reject late data: input.timestamp before bucketStart
    if (input.timestamp < state.bucketStart) {
      metrics.lateSamplesDropped.inc({ propertyId: prop.id });
      return;
    }
    // Reject future-window data: input.timestamp >= bucketEnd (shouldn't normally happen)
    if (input.timestamp >= state.bucketEnd) {
      // input arrived before bucket close timer fired; fast-close and reopen
      this.closeBucket(prop);
      // re-route this input into the new bucket
      return this.onInput(prop, input);
    }
    // Skip bad-quality inputs from aggregation
    if (input.quality === 'bad') {
      state.totalCount++;
      return;
    }
    const v = Number(input.value);
    if (Number.isNaN(v)) {
      state.totalCount++;
      return;
    }
    state.count++;
    state.totalCount++;
    if (input.quality === 'good') state.goodCount++;
    state.sum += v;
    state.min = state.min === null ? v : Math.min(state.min, v);
    state.max = state.max === null ? v : Math.max(state.max, v);
  } else {
    // ewma
    const v = Number(input.value);
    if (Number.isNaN(v) || input.quality === 'bad') return;
    state.value = prop.resolver.alpha * v + (1 - prop.resolver.alpha) * state.value;
    state.lastInputTs = input.timestamp;
    state.lastInputQuality = input.quality;
    // EWMA emits on every input
    this.emitEwma(prop, state);
  }
  // Persist state (debounced — see §17.7 below)
  this.scheduleStateFlush(prop.id);
}
```
On bucket close (tumbling only):
```ts
closeBucket(prop: WindowProperty) {
  const state = this.aggStateCache.get(prop.id);
  const envelope = this.buildTumblingEnvelope(prop, state);   // computes avg etc.
  this.kv.put(`prop.${prop.id}`, JSON.stringify(envelope));
  // Mark dependents dirty (window output can feed an expr property)
  this.markDependentsDirty(prop.id);
  // Advance to next bucket
  state.bucketStart = state.bucketEnd;
  state.bucketEnd = state.bucketStart + prop.resolver.windowMs;
  state.count = 0;
  state.totalCount = 0;
  state.goodCount = 0;
  state.sum = 0;
  state.min = null;
  state.max = null;
  this.scheduleStateFlush(prop.id);
  this.scheduleCloseTimer(prop);
}
```
17.6 Quality propagation for windows
Window output quality is computed at emit time:
Tumbling — `count: 0` (no good samples received): quality = `bad`
Tumbling — `goodCount / totalCount < 0.5`: quality = `uncertain` (more bad/stale than good)
Tumbling — otherwise: quality = `good`
EWMA — `lastInputQuality` is propagated directly (event-driven; no time decay to worry about)
The thresholds are hardcoded in v1. Promote to per-property config if customers ask.
17.7 State persistence cadence
Writing to KV on every input is wasteful. EWMA on a 10Hz tag is 10 writes/sec to KV per property — fine for one property, problematic at scale.
Debounce strategy:
Update in-memory state immediately (so reads are correct)
Schedule a flush to KV every 500ms (per property), coalescing intermediate writes
On bucket close: flush immediately (durability matters for the emitted bucket)
On graceful shutdown: flush all pending
Tradeoff: a hard crash loses up to 500ms of state. For tumbling that's a minor under-count in the active bucket; for EWMA it's a slightly stale value. Both acceptable.
17.8 Restart behavior
Tumbling on restart:
Load state. `bucketStart`, `bucketEnd`, accumulator fields. State is reused only if it matches the current config's bucket grid (`bucketEnd == bucketStart + windowMs` and `bucketStart` on the `alignToMs` grid) — an edited `windowMs`/`alignToMs` invalidates it (fresh bucket, logged).
If `now < bucketEnd`: bucket is still open. Schedule close timer for `bucketEnd - now`. Resume accepting input.
If `now >= bucketEnd`: bucket closed during downtime. Emit it with `quality: 'stale'` (we know it's incomplete). If further buckets were skipped, emit one gap marker — the last missed bucket as `count: 0, quality: 'bad'` with `context.gapBuckets: N` — then open the bucket containing `now`. (Deliberately not one emit per missed bucket: all emits overwrite the same KV key, so only the last would survive anyway; the marker preserves "operators see the gap rather than a phantom continuous trend" at O(1). A 1s window down for a day would otherwise mean 86k pointless writes.)
The same close-and-jump path handles live event-time jumps (§17.9) and very-late close timers (process suspended past a boundary).
EWMA on restart:
Load state. `value`, `lastInputTs`.
Resume on next input. No fast-forward needed (event-driven).
If `lastInputTs` is very old (>1 hour or some threshold), set quality to `stale` on next read until a fresh input arrives.
17.9 Event time vs processing time
For tumbling, use the input envelope's `timestamp` to decide bucket membership, not the receive time. This matters when Edge replays buffered messages after a network gap. Two boundary cases:
Envelope timestamp `< bucketStart`: late data. Drop, increment metric.
Envelope timestamp `>= bucketEnd`: future data relative to current bucket. The bucket close timer should have fired; if it hasn't (rare, but possible with system clock skew or GC pause), close the current bucket immediately and re-route the input.
EWMA doesn't care — it has no buckets, just incorporates inputs in arrival order.
17.10 Subscribing a window's output
Window output is just a property in KV like any other. The WS gateway and `expr` properties consume it identically. There's no special "window subscription" path. This is why we don't allow `window` properties to source other `window` properties in v1: chaining works mechanically, but debugging "why did this window output go stale" gets hard when state lives in multiple linked aggregators. Lift the restriction in v2 once the basic case is stable.
18. Structural aggregations (`rollup` resolver)
This section specifies the v1 implementation of the `rollup` resolver — aggregation over a node's child assets in the asset hierarchy (§4.6). It is the spatial analog of §17: `window` aggregates one property over time; `rollup` aggregates one property over a set of child nodes.
18.1 What a rollup computes
A `rollup` property on a parent node aggregates one named property across the parent's children:
```
Workcenter A . oee     = weighted-avg over (its Stations) . oee
Workcenter A . parts   = sum over (its Stations) . partsThisShift
Site . oee             = weighted-avg over (its Workcenters) . oee
```
The children are found by entity relation: `childKind` (the kind of node to aggregate) + `relation` (the Prisma relation from the parent's entity to the children). `childProperty` is the property name read off each child. Because all nodes of a kind share a property schema (§4.6), `childProperty` resolves uniformly.
Rollups compose: `Site.oee` is a rollup over Workcenters, each of whose `oee` is itself a rollup over Stations. A rollup-of-rollups. Depth is capped at 3 (Site→Workcenter→Station) in v1.
18.2 Weighted aggregation
`weightBy` is optional but important. A plain average of station OEEs is usually the wrong workcenter KPI — a press that ran 10 parts shouldn't count equally with one that ran 1,400. With `weightBy: 'partsProduced'`:
```
weighted_avg = Σ(childᵢ.value × childᵢ.weight) / Σ(childᵢ.weight)
```
`weightBy` applies to `avg` only; ignored for `sum/count/min/max`. If any child's weight is missing or zero, that child is excluded from the weighted average (and contributes to `uncertain` quality — see §18.5). Build weighting in from the start; it's the difference between a real KPI and a misleading one.
18.3 Dynamic membership — the hard part
Unlike `expr` (fixed input set) and `window` (one source), a rollup's inputs are "whatever children exist right now." The engine maintains an in-memory index:
```ts
rollupChildren: Map<rollupPropertyId, Set<childPropertyId>>
```
Built at boot and refreshed on membership change. "Membership change" means a child was added, removed, or reassigned — e.g., a Station moved from Workcenter A to Workcenter B. This is a distinct event from a value change.
Two invalidation triggers:
Child value change — rides the existing dirty mechanism. Each `childPropertyId` in the index is a dependency of the rollup; when it updates, the rollup is marked dirty and recomputed on the next flush. Mechanically identical to an expr dependency.
Membership change — a new domain event, `asset.moved` (or `asset.created` / `asset.deleted` scoped to a relevant kind). On receipt: rebuild the affected rollup's child set in the index, re-wire the dependency edges (drop departed children, add new ones), mark the rollup dirty.
The domain-event bus (§8.2) already carries entity mutations; membership events are a typed subset. The publisher (Fastify mutation handlers) must emit `asset.moved` whenever a foreign key that defines hierarchy membership (`Station.workcenterId`, `Workcenter.siteId`) changes.
18.4 Engine integration
```ts
// Pseudocode — evaluate a rollup
evaluateRollup(prop: RollupProperty): ValueEnvelope {
  const childPropIds = this.rollupChildren.get(prop.id) ?? new Set();
  const r = prop.resolver;
  let acc = r.aggregation === 'min' ? +Infinity
          : r.aggregation === 'max' ? -Infinity : 0;
  let count = 0, weightSum = 0, weightedSum = 0;
  let worstQuality: Quality = 'good';
  let present = 0;

  for (const cpId of childPropIds) {
    const child = this.properties.get(cpId);
    if (!child || child.current.quality === 'bad') { worstQuality = 'uncertain'; continue; }
    const v = Number(child.current.value);
    if (Number.isNaN(v)) { worstQuality = 'uncertain'; continue; }
    present++;
    worstQuality = worse(worstQuality, child.current.quality);
    switch (r.aggregation) {
      case 'sum':   acc += v; break;
      case 'count': count++; break;
      case 'min':   acc = Math.min(acc, v); break;
      case 'max':   acc = Math.max(acc, v); break;
      case 'avg':
        if (r.weightBy) {
          const w = this.readSiblingWeight(child, r.weightBy);  // same node, weightBy property
          if (w > 0) { weightedSum += v * w; weightSum += w; }
          else worstQuality = 'uncertain';
        } else { acc += v; count++; }
        break;
    }
  }

  let value: number;
  if (r.aggregation === 'count') value = childPropIds.size;
  else if (r.aggregation === 'avg') value = r.weightBy
        ? (weightSum > 0 ? weightedSum / weightSum : null)
        : (count > 0 ? acc / count : null);
  else value = present > 0 ? acc : null;

  const quality = present === 0 ? 'bad'
                : present < childPropIds.size ? worse(worstQuality, 'uncertain')
                : worstQuality;
  return { value, quality, timestamp: Date.now(),
           context: { childCount: childPropIds.size, present } };
}
```
Rollups dispatch in the same flush loop as expr (§8.5), in topo order — so a Station→Workcenter→Site chain evaluates bottom-up within one flush.
18.5 Quality propagation for rollups
No children present (all bad/missing): quality = `bad`
Some but not all children present: quality = `uncertain` (partial rollup — a station is down or hasn't reported)
All present: quality = worst of the children's qualities
Weighted avg with missing/zero weights: those children excluded, quality drops to `uncertain`
The `context.present / context.childCount` lets the dashboard show "based on 4 of 5 stations" — valuable on a plant floor where a press being offline shouldn't silently skew the workcenter number.
18.6 Cycle and depth checks (save-time)
A rollup cannot aggregate a `childProperty` whose own resolver transitively depends on this rollup (would loop). The existing cycle check (§8.8) extends to rollup edges — but since rollup edges are dynamic, the check is on the kind/relation/property triple, not specific instances: reject if `childKind.childProperty` could reach this rollup's node-kind property through the static graph.
Reject rollup chains deeper than 3 hops.
Validate `relation` exists in the ObjectSchema-backed data catalog and points to `childKind`.
18.7 Restart behavior
Rollups hold no durable accumulator state — they recompute from current child values. On boot: build the `rollupChildren` index from entity relations, mark all rollups dirty, evaluate in topo order once children are seeded from KV. Simpler than windows (no `imm_agg_state` involvement).
18.8 Relation to dashboard repeaters (consumption layer)
Rollups (data up) and repeaters (render down) traverse the same Prisma relations but live in different layers. The repeater — "render one KPI tile per child of this node" — is a dashboard/UI feature (separate workstream, §15), not an engine resolver. It depends on three engine-side capabilities the spec now provides:
Collection resolution — "children of kind X under node Y" — a query over entity relations the engine already performs for rollups; expose it via REST for the dashboard layer.
Relative property resolution — given a node and a property name (`$node.oee`), return the property ID to subscribe to. Trivial given the kind/property-schema guarantee.
Live membership — the same `asset.moved` events that invalidate rollups let a dashboard add/remove a tile when the collection changes.
The dashboard builder is built on these; it doesn't need new engine primitives beyond them.
19. Open questions for product
Entity binding granularity. Resolved: node-level. A node is bound to one entity instance (`entityType`/`entityId`); all its entity properties read from that instance, and its relations are the asset-tree edges. This is what makes rollups and repeaters resolve uniformly. (Property-level binding is not supported; a property that needs a different entity belongs on a different node, or uses a relation traversal path.)
Node-kind templates — how much in v1? v1 ships kinds as a label + property-set convention, with a one-time sync materializing a node per existing Station/Workcenter/Site. Full auto-instantiation (new entity → node appears automatically; edit the template → all instances update) is deferred. Confirm the one-time-sync approach is enough for launch, or whether auto-instantiation is needed day one.
Object value display. When a property's value is an object, how does the dashboard render it? Flag for the UI team.
Quality model: 4-state vs simpler. Spec uses `good/stale/uncertain/bad`. Rollup partial-coverage relies on `uncertain` being meaningful. Confirm.
Shift configuration UX. v1 uses `alignToMs` to anchor tumbling buckets. Acceptable, or is a richer shift-config concept (named shifts, day-of-week variation) needed in v1?
EWMA alpha picker UX. Should the UI translate alpha to "smoothing window ≈ N samples" / "half-life ≈ N seconds"? Worth deciding before the editor is built.
Weighted-rollup default. Should `avg` rollups default to weighted (by parts produced) when a sensible weight property exists, or require the builder to opt in explicitly? Weighted is usually correct but less obvious.
User-defined entity relations timeline. v1 user entities are standalone (§5.1). The first thing customers will want is to relate a user entity to a `Station` (e.g. an inspection record → the press it was taken on). When does that move from deferred to scheduled? It's the gateway to user entities participating in rollups.
Where to draw the system/user tier line. Some things could be modeled either way (a custom asset type). Guidance: if it has relations, lives on the hot path, or needs queryable history → system (Prisma). If it's cool, low-churn, customer-specific metadata → user tier. Confirm this litmus test, since misclassifying pushes operational data into the JSONB tier where it doesn't belong.
20. References
Ignition Designer's tag/expression model (prior art)
OPC UA address space — nodes with multiple variables under them (closest analog to this node/property model)
ISA-95 equipment hierarchy: Enterprise → Site → Area → Work Center → Work Unit (maps to Site → Workcenter → Station)
mathjs expression API: https://mathjs.org/docs/expressions/parsing.html
NATS JetStream KV: https://docs.nats.io/nats-concepts/jetstream/key-value-store
Apache Flink windowing semantics (event time, late data, watermarks — prior art for §17.9)
EWMA in process control: https://en.wikipedia.org/wiki/Exponential_smoothing
ObjectSchema-backed data catalog: system records plus user-authored document definitions
Postgres JSONB + GIN indexing (storage model for the user-defined entity tier, §5.1)
EAV vs JSONB vs dynamic-DDL tradeoffs (background for the §5.1 storage decision)

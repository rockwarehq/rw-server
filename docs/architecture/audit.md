# Audit trail

The audit trail is how we answer **who did what, when, where from, and to which record**: for customers ("who changed this part?"), for support, and for security, including anything a connected agent did.

## The record

`AuditLog` (`packages/db/schema/audit-log.prisma`) is one append-only table.

| Column | Meaning |
| --- | --- |
| `action` | What happened (`AuditAction`) |
| `actorId` | Who did it: the signed-in person. Null when anonymous, e.g. a failed login |
| `userId` | The person the event is about, when that's someone else (an invitee, a locked-out user) |
| `workspaceId`, `siteId` | Where. `siteId` is the plant, when the event belongs to one |
| `entityType`, `entityId` | The record it happened to, e.g. `product` + its id, `employee` + its id |
| `changes` | `{ field: { from, to } }` for edits. Never secrets |
| `versionId`, `previousVersionId` | For a versioned record: the version the change made, and the one it replaced |
| `via` | How the actor came in: `ui`, `staff`, `display`, `api-token`, `system`, or `agent:<client name>` (a person acting through an agent they connected, e.g. `agent:Claude Code`) |
| `requestId` | Ties together the entries one request wrote |
| `ipAddress`, `userAgent` | Where from |
| `metadata` | Anything else the action needs (counts, reasons, ids) |
| `createdAt` | When |

Indexes serve the three questions we ask: what happened at a plant or workspace (`siteId`/`workspaceId` + `createdAt`), what happened to a record (`entityType` + `entityId` + `createdAt`), and what a person did (`actorId` + `createdAt`).

## Writing

Use `logEvent` from `@rw/services/audit`.

- **The context fills in who and where.** The API opens an audit context for every request (`apps/api/src/auth/plugin.ts`, `onRequest`) with the IP, user agent and request id, and adds the actor once the caller is known: the person, workspace, plant and `via` (`apps/api/src/auth/audit.ts`). `/mcp` does the same for OAuth callers. A call site passes only what it knows better: the action, the record, the changes, the metadata.
- **Write inside the transaction when there is one.** `logEvent({ ..., tx })` writes in the caller's transaction: the change and its entry commit or roll back together, and a failed audit write fails the change. Without `tx` it writes on its own afterwards and never throws (an entry that fails is logged); keep that for events with no transaction of their own, such as logins.
- **Name the record.** Set `entityType` and `entityId` whenever the event is about one record, so its history can be found.
- **Background work** (workers, the setup runner) has no request context: pass `actorId` (the person who started it) and, when it's nobody, `via: "system"`.

## Record history

Master data records its own history: `RECORD_CREATED`, `RECORD_UPDATED` and `RECORD_DELETED`, with `entityType` and `entityId` naming the record and `metadata.label` its name at the time. Services write it with `auditRecord(tx, ...)` (`packages/services/src/audit/record.ts`) inside the transaction that makes the change.

- **Fields are named per record type.** Only the named fields are compared, which is also what keeps secrets out: an employee's PIN or badge change is recorded as `metadata.pinChanged` / `badgeChanged`, never its value.
- **An update that changed none of them records nothing.**
- **Versioned records** (product, material, job, tool, station, employee) follow the recording and recordable shape, as Basecamp does. Each change is a new version that never changes; the entry points from the version it replaced (`previousVersionId`) to the one it made (`versionId`), and every version records who made it (`createdById`). `changes` is then a summary; the versions hold the full values. An import's "undo and delete for good" can remove a version it made, so a pointer can outlive its version.
- **Unversioned records** (workcenters, plant settings, reasons and categories, production modes, labels, customers, orders) keep their before and after values in `changes`.
- **Parts of a record** are changes to the record: a materials list line is an update to its product, a cavity to its tool, a job's products and tools to the job, an order's lines to the order, with metadata saying which part (`materialsList: "added"`, `cavity`, ...).

| Record | Entity type | Covered |
| --- | --- | --- |
| Products (and materials lists, alternates, duplicate, archive) | `product` | `inventory/product.ts` |
| Materials | `material` | `inventory/material.ts` |
| Jobs (and their products and tools) | `job` | `job/job.ts` |
| Tools (and cavities) | `tool` | `job/tool.ts` |
| Stations (create, edit, move, reorder, delete, profile applied) | `station` | `facility/station/crud.ts`, `station-profile/apply.ts` |
| Workcenters | `workcenter` | `facility/workcenter/crud.ts` |
| Employees | `employee` | `apps/api/src/services/employee/crud.ts` |
| Plant (name, time zone, settings, logo) | `site` | `facility/site/*` |
| Downtime reasons, categories | `status-reason`, `status-category` | `facility/status-*` |
| Production modes | `production-mode` | `facility/production-mode/crud.ts` |
| Labels | `label` | `label/crud.ts` |
| Customers, orders (and lines, status) | `customer`, `order` | `order/*` |

Not covered on purpose: stock and ledger rows (they record `performedByUserId` themselves), shop-floor runtime (station state, cycles, calls, logons, shift materialisation), product pictures, alternates-group renames, and order queue reordering.

Operators aren't users: their logon events name the employee as the record (`entityType: "employee"`) and carry the display's workspace and plant.

## Not written

Four `AuditAction` values are kept but never written (Postgres can't drop enum values cheaply): `INVITE_VERIFIED` and `INVITE_FAILED` (invites complete through the password reset, `INVITE_COMPLETED`), and `OPERATOR_SUPERVISOR_CHALLENGE` / `_FAILED` (supervisor approval isn't built).

## Next

1. Explicit actions for security-relevant settings: workspace access and roles, user profiles, plant settings, integrations, automations, employee roles, devices, documents.
2. Reading: `audit.search` and a record's history, an IMM Activity page and History on each record, CSV export.
3. Append-only enforced in the database, and a written retention policy.

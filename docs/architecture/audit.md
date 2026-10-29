# Audit trail

The audit trail is how we answer **who did what, when, where from, and to which record**: for customers ("who changed this part?"), for compliance, for support, and for security, including anything a connected agent did.

It is a record, not a feed. It is complete (failed sign-ins and secrets-changed flags included), append-only, kept for the life of the workspace, and read by plant admins. It is **not** where engagement or usage lives: page views, "who's active", adoption counts and activity feeds for everyone are a separate concern, built from production data (logon sessions, calls, sign-offs) or their own store, never by reading or widening this table.

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

**Where from is the person's address.** On fly the API sits behind fly's edge proxy, so the socket is the proxy; `TRUST_PROXY=1` (every tenant, `apps/api/fly/base.toml`) takes the address the proxy added to `X-Forwarded-For` and ignores any the client wrote itself. A CDN in front of fly would add a hop. A plant behind one router shows as one address. Callers reaching the API inside fly's network (`.internal`) skip the proxy; they're our own services. Entries written before this setting hold the proxy's address (`fdaa:…`) and keep it.

Indexes serve the three questions we ask: what happened at a plant or workspace (`siteId`/`workspaceId` + `createdAt`), what happened to a record (`entityType` + `entityId` + `createdAt`), and what a person did (`actorId` + `createdAt`).

## Writing

Use `logEvent` from `@rw/services/audit`.

- **The context fills in who and where.** The API opens an audit context for every request (`apps/api/src/auth/plugin.ts`, `onRequest`) with the IP, user agent and request id, and adds the actor once the caller is known: the person, workspace, plant and `via` (`apps/api/src/auth/audit.ts`). `/mcp` does the same for OAuth callers. A call site passes only what it knows better: the action, the record, the changes, the metadata.
- **Write inside the transaction when there is one.** `logEvent({ ..., tx })` writes in the caller's transaction: the change and its entry commit or roll back together, and a failed audit write fails the change. Without `tx` it writes on its own afterwards and never throws (an entry that fails is logged); keep that for events with no transaction of their own, such as logins.
- **Name the record.** Set `entityType` and `entityId` whenever the event is about one record, so its history can be found.
- **Background work** (workers, the setup runner) has no request context: open one with `runWithAuditContext` naming the person who started it, and `via: "system"` (the setup runner does, for a run picked up after a restart). An entry with no caller still belongs to the account: `logEvent` falls back to the one workspace, so a failed sign-in shows in the Audit Log.

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
| A person's access: plant level, workcenter grants, account admin; removed from the workspace | `member` (the user's id, one entry per plant) | `apps/api/src/services/account/workspace/members.ts` |
| Profile edits (name, email) | `user` | `apps/api/src/services/account/user/crud.ts` |
| Team roles | `employee-role` | `employee/role.ts` |
| Integrations (and their triggers) | `integration` | `integration/crud.ts`, `livestore/src/graph/triggers.ts` |
| Automations | `automation` | `automation/store.ts` |
| Notification groups, saved overhead pages | `notification-group`, `overhead-page` | `notification/group.ts`, `paging/pages.ts` |
| Gateways, devices (datasources, published or not) | `gateway`, `datasource` | `device/gateway/crud.ts`, `apps/api/src/services/device/datasource/crud.ts` |
| Documents (folders, uploads, versions, links) | `document` (versions point at their DocumentFile) | `document/index.ts` |

Secrets never reach the trail. Credentials, tokens and passwords are left out of the compared fields and recorded only as `credentialsChanged`; an integration's URLs and default headers aren't recorded at all (a webhook URL can itself be a credential), and a device's connection settings drop any key that looks like a secret, any value that carries one (a connection string with `Password=`), and a URL's `user:password@`. A PIN or badge change is `pinChanged` / `badgeChanged`.

Floor records name their workcenters in `metadata.workcenterIds` (a station's cell, both cells for a move, a workcenter itself): where a change happened, as it was then.

Background work (an import applying a chunk at a time) runs in an audit context of its own: the person who started it, and one id for everything it wrote.

Not covered on purpose: stock and ledger rows (they record `performedByUserId` themselves), shop-floor runtime (station state, cycles, calls, logons, shift materialisation), product pictures, alternates-group renames, and order queue reordering.

Operators aren't users: their logon events name the employee as the record (`entityType: "employee"`) and carry the display's workspace and plant. Ending several sessions at once (log everyone off, single-logon enforcement) writes one entry per session ended, in the same transaction. `audit.teamMemberLogons` (plant ADMIN) lists one team member's logons at that plant's terminals together with their login's sign-ins and password and invitation events, without edits to their record; reads name the operator and the station.

## Agents

An entry has one of three authors, and the trail says which:

- **A person**: `actorId`, no agent `via`.
- **An agent acting for a person**: `actorId` is the person, `via: agent:<name>`. They asked it (a Console chat) or connected it and it used their access (MCP). IMM says "Claude and Admin changed …", with the agent's logo on the corner of the person's avatar.
- **An agent acting on its own**: `via: agent:<name>`, started by `trigger: hook | schedule` rather than by anyone at the time. `actorId` is whoever set it going, whose access it runs with; IMM names the agent as the author and that person after ("on a schedule Admin set up"). An agent with an identity of its own (no person behind it) writes no `actorId` at all, and IMM names the agent alone. None exists yet: every Console session today has a person.

- **Connected agents** (Claude Code, Codex, ChatGPT over MCP + OAuth) can read and propose, revise or discard imports, nothing else (`apps/api/src/agent/scopes.ts`). Their entries name the person who connected them, `via: agent:<client>`, the IP and a request id. Connecting, revoking and the agent-connections policy are recorded (`OAUTH_GRANT_*`, `AGENT_CONNECTIONS_POLICY_CHANGED`).
- **The Console's own agent** (`apps/api/src/agent/runner.ts`) runs in the background and calls the router in-process, so each tool call runs in an audit context of its own: its session's person, `via: agent:<agent name>`, request id `agent:<session id>`, and in metadata the session, what started a run that wasn't a chat (`trigger: hook | schedule | subagent`) and who approved the call (`approvedById`). There's no IP: there's no request.
- **Imports an agent proposed** say so: the changeset records the agent (`author: AGENT`, `clientName`), and a person applies it in IMM (`via: ui`). Every change the apply makes carries `metadata.origin` — the changeset, its title and `proposedVia` — so a record's history says which import, and which agent, it came from. An undo carries the same origin with `undo: true`.
- **Reads aren't recorded**, an agent's or a person's: the trail records changes and proposals.

## Reading it

All in `apps/api/src/rpc/audit.ts`; none is agent-callable.

- `audit.search` — a plant's trail, newest first, filtered by person, record, action, `via` and time, cursor-paged, with where-from. Plant ADMIN.
- `audit.recordHistory` — one record's history, without where-from. The catalog and the floor (products, materials, jobs, tools, orders, customers, documents, labels, stations, workcenters) for anyone at the plant; a station or workcenter needs access to that cell, and once deleted, plant ADMIN. Everything else — team members, users, roles, access, devices, integrations, the plant's setup — plant ADMIN, as their own pages are.
- `audit.teamMemberLogons` — see above. Plant ADMIN.
- `audit.actors` — the people in a plant's trail, for the filter. Plant ADMIN.
- `audit.exportCsv` — the filtered trail as CSV, up to 20,000 rows. Plant ADMIN. **Taking the trail out is recorded**: `AUDIT_EXPORTED` with the filters and row count, written before the file is returned; no entry, no export.

IMM shows it as Settings → Audit log, and as History / Change history / Logons on records.

## Not written

Four `AuditAction` values are kept but never written (Postgres can't drop enum values cheaply): `INVITE_VERIFIED` and `INVITE_FAILED` (invites complete through the password reset, `INVITE_COMPLETED`), and `OPERATOR_SUPERVISOR_CHALLENGE` / `_FAILED` (supervisor approval isn't built).

## Keeping it

**Append-only.** The database refuses `UPDATE`, `DELETE` and `TRUNCATE` on `AuditLog` (trigger `audit_log_append_only`, migration `20261023130000_audit_trail`), whatever the application tries. It guards against the application, not the database's owner: any role can set the bypass setting, and the table's owner can disable the trigger. Hardening that is deployment work — the application's role without `UPDATE`/`DELETE` on `AuditLog`, and a separate owner. The one sanctioned rewrite is a maintenance script's own transaction that sets `SET LOCAL rockware.audit_bypass = 'on'` first — today only `apps/api/scripts/collapse-workspaces.ts`, a dev tool that refuses to run in production. Nothing in the application sets it. A correction is a new entry, never an edit.

**Retention.** Entries are kept for as long as the workspace exists; nothing purges them. They are small (a few hundred bytes; a plant making a few thousand changes a day writes well under a gigabyte a year), and an audit trail that forgets defeats its purpose. If a customer needs a limit (a contract, a regulation), it becomes a per-workspace setting with a purge job that runs in a sanctioned maintenance transaction, records that it ran, and keeps the record of the purge itself. Until then there is no limit, and none should be added ad hoc.

**What an entry can outlive.** Entries have no foreign keys, so they stay when what they point at goes:
- A deleted person's entries keep their `actorId`; the name is gone, so history shows "Someone".
- A record deleted for good (a station today, an import's "undo and delete for good") keeps its entries; `metadata.label` still names it.
- "Undo and delete for good" can remove a version an import made, so an entry's `versionId` / `previousVersionId` can point at a version that no longer exists. Its `changes` still say what changed.

**Open decision: station delete.** ADR-0007 says station delete should be a soft delete, so its manufacturing history stays; the code still hard-deletes (`facility/station/crud.ts`), taking its versions with it. The audit trail records the delete and the station's name, but the station's own version history is gone. Making station delete soft is a separate change with its own consequences (lists, uniqueness of names, devices), to decide on its own.

## Next

1. Station delete as a soft delete (ADR-0007), decided on its own.
2. If customers need it (regulated manufacturing, e.g. 21 CFR Part 11): tamper evidence (a hash chain over entries, checkable on export), a reason for change on regulated edits, and electronic signatures.

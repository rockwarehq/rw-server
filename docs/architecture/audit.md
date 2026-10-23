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

Operators aren't users: their logon events name the employee as the record (`entityType: "employee"`) and carry the display's workspace and plant.

## Not written

Four `AuditAction` values are kept but never written (Postgres can't drop enum values cheaply): `INVITE_VERIFIED` and `INVITE_FAILED` (invites complete through the password reset, `INVITE_COMPLETED`), and `OPERATOR_SUPERVISOR_CHALLENGE` / `_FAILED` (supervisor approval isn't built).

## Next

1. Master data audited by default, through the service layer's entity events, with before and after values; version tables record who made each version.
2. Explicit actions for security-relevant settings: workspace access and roles, user profiles, plant settings, integrations, automations, employee roles, devices, documents.
3. Reading: `audit.search` and a record's history, an IMM Activity page and History on each record, CSV export.
4. Append-only enforced in the database, and a written retention policy.

import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@rw/db";
import { z } from "zod";

import { logEvent } from "@rw/services/audit/index";

import { userRequired } from "./middleware.js";

// Reading the audit trail (docs/architecture/audit.md). A plant's activity is
// for its admins: who did what, when, from where. A record's history is for
// anyone who can see the record. Both include workspace-level entries (an
// employee, who belongs to the workspace, not a plant) alongside the plant's
// own. Never agent-callable (not in AGENT_CALLABLE).

const PAGE = 50;
const EXPORT_MAX = 20_000;

const filtersSchema = z.object({
  siteId: z.uuid(),
  actorId: z.uuid().optional(),
  entityType: z.string().min(1).max(64).optional(),
  entityId: z.string().min(1).max(64).optional(),
  actions: z.array(z.string().min(1).max(64)).max(50).optional(),
  via: z.string().min(1).max(120).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

type Filters = z.infer<typeof filtersSchema>;

/** A plant's entries, plus its workspace's entries that belong to no plant. */
function where(filters: Filters, workspaceId: string): Prisma.AuditLogWhereInput {
  return {
    OR: [{ siteId: filters.siteId }, { siteId: null, workspaceId }],
    ...(filters.actorId ? { actorId: filters.actorId } : {}),
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.entityId ? { entityId: filters.entityId } : {}),
    ...(filters.actions?.length ? { action: { in: filters.actions as never } } : {}),
    ...(filters.via ? { via: filters.via } : {}),
    ...(filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from ? { gte: new Date(filters.from) } : {}),
            ...(filters.to ? { lt: new Date(filters.to) } : {}),
          },
        }
      : {}),
  };
}

/** "<createdAt ISO>|<id>": newest first, stable across equal timestamps. */
function cursorWhere(cursor: string | undefined): Prisma.AuditLogWhereInput {
  if (!cursor) return {};
  const [at, id] = cursor.split("|");
  if (!at || !id) throw new ORPCError("BAD_REQUEST", { message: "Bad cursor" });
  const createdAt = new Date(at);
  return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
}

type Row = Awaited<ReturnType<typeof prisma.auditLog.findMany>>[number];

function personName(p: { firstName: string | null; lastName: string | null; email: string }) {
  return [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email;
}

/** Rows as people read them: names for the actor and the person it was about. */
async function present(rows: Row[], options: { network: boolean }) {
  const ids = [...new Set(rows.flatMap((row) => [row.actorId, row.userId]).filter((id): id is string => !!id))];
  const people = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const names = new Map(people.map((p) => [p.id, personName(p)]));
  const operators = await operatorNames(rows);
  return rows.map((row) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const operator = operators(row);
    return {
      id: row.id,
      at: row.createdAt,
      action: row.action,
      actor: row.actorId ? { id: row.actorId, name: names.get(row.actorId) ?? null } : null,
      subject: row.userId ? { id: row.userId, name: names.get(row.userId) ?? null } : null,
      via: row.via,
      siteId: row.siteId,
      entityType: row.entityType,
      entityId: row.entityId,
      label: typeof metadata.label === "string" ? metadata.label : (operator.employee ?? null),
      changes: (row.changes as Record<string, { from: unknown; to: unknown }> | null) ?? null,
      versionId: row.versionId,
      previousVersionId: row.previousVersionId,
      metadata: operator.station ? { ...metadata, stationName: operator.station } : metadata,
      requestId: row.requestId,
      // Where from is for the plant's admins, not everyone who can see a record.
      ...(options.network ? { ipAddress: row.ipAddress, userAgent: row.userAgent } : {}),
    };
  });
}

const OPERATOR_ACTIONS = ["OPERATOR_LOGON", "OPERATOR_LOGOFF", "OPERATOR_LOGON_FAILED"] as const;

/**
 * Operators aren't users and their logon entries carry ids only: name the
 * team member and the station, as they are now, so the entry reads as a
 * sentence.
 */
async function operatorNames(rows: Row[]) {
  const operatorRows = rows.filter((row) => (OPERATOR_ACTIONS as readonly string[]).includes(row.action));
  const employeeIds = new Set<string>();
  const stationIds = new Set<string>();
  for (const row of operatorRows) {
    if (row.entityType === "employee" && row.entityId) employeeIds.add(row.entityId);
    const stationId = (row.metadata as Record<string, unknown> | null)?.stationId;
    if (typeof stationId === "string") stationIds.add(stationId);
  }
  const [employees, stations] = await Promise.all([
    employeeIds.size
      ? prisma.employee.findMany({
          where: { id: { in: [...employeeIds] } },
          select: { id: true, version: { select: { firstName: true, lastName: true } } },
        })
      : [],
    stationIds.size
      ? prisma.station.findMany({ where: { id: { in: [...stationIds] } }, select: { id: true, name: true } })
      : [],
  ]);
  const employeeName = new Map(
    employees.map((e) => [e.id, [e.version?.firstName, e.version?.lastName].filter(Boolean).join(" ") || null]),
  );
  const stationName = new Map(stations.map((s) => [s.id, s.name]));
  return (row: Row) => {
    if (!(OPERATOR_ACTIONS as readonly string[]).includes(row.action)) return { employee: null, station: null };
    const stationId = (row.metadata as Record<string, unknown> | null)?.stationId;
    return {
      employee: row.entityType === "employee" && row.entityId ? (employeeName.get(row.entityId) ?? null) : null,
      station: typeof stationId === "string" ? (stationName.get(stationId) ?? null) : null,
    };
  };
}

async function page(whereInput: Prisma.AuditLogWhereInput, cursor: string | undefined, limit: number) {
  const rows = await prisma.auditLog.findMany({
    where: { AND: [whereInput, cursorWhere(cursor)] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const more = rows.length > limit;
  const shown = more ? rows.slice(0, limit) : rows;
  const last = shown[shown.length - 1];
  return { rows: shown, nextCursor: more && last ? `${last.createdAt.toISOString()}|${last.id}` : null };
}

/** A plant's activity, newest first, filtered and paged. Plant ADMIN. */
export const search = userRequired
  .input(
    filtersSchema.extend({
      cursor: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).default(PAGE),
    }),
  )
  .handler(async ({ input, context }) => {
    await context.access.require("ADMIN", { site: input.siteId });
    const { cursor, limit, ...filters } = input;
    const result = await page(where(filters, context.current.workspaceId), cursor, limit);
    return { entries: await present(result.rows, { network: true }), nextCursor: result.nextCursor };
  });

/** One record's history, newest first. Anyone who can see the record. */
export const recordHistory = userRequired
  .input(
    z.object({
      siteId: z.uuid(),
      entityType: z.string().min(1).max(64),
      entityId: z.string().min(1).max(64),
      cursor: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).default(PAGE),
    }),
  )
  .handler(async ({ input, context }) => {
    await context.access.require("VIEW", { site: input.siteId });
    // A station or workcenter is for the crew who can see that cell.
    if (input.entityType === "station") await context.access.require("VIEW", { station: input.entityId });
    if (input.entityType === "workcenter") await context.access.require("VIEW", { workcenter: input.entityId });
    const filters = { siteId: input.siteId, entityType: input.entityType, entityId: input.entityId };
    const result = await page(where(filters, context.current.workspaceId), input.cursor, input.limit);
    return {
      entries: await present(result.rows, { network: false }),
      nextCursor: result.nextCursor,
    };
  });

/** Signing in to Rockware: what a team member's login did, or had done to it. */
const SIGN_IN_ACTIONS = [
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "LOGIN_LOCKED",
  "LOGOUT",
  "ACCOUNT_UNLOCKED",
  "PASSWORD_CHANGED",
  "PASSWORD_ADMIN_RESET",
  "PASSWORD_RESET_REQUESTED",
  "PASSWORD_RESET_COMPLETED",
  "USER_INVITED",
  "INVITE_COMPLETED",
  "INVITE_REVOKED",
  "INVITE_EXPIRED",
  "USER_DISABLED",
  "USER_ENABLED",
] as const;

/**
 * A team member's logons, newest first: at a terminal (logged on, logged
 * off, a failed PIN) and, when they have a login, signing in to Rockware
 * (signed in and out, failed or locked out, password and invitation events).
 * Not edits to their record. Plant ADMIN, with where-from.
 */
export const teamMemberLogons = userRequired
  .input(
    z.object({
      siteId: z.uuid(),
      employeeId: z.uuid(),
      cursor: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).default(PAGE),
    }),
  )
  .handler(async ({ input, context }) => {
    await context.access.require("ADMIN", { site: input.siteId });
    const employee = await prisma.employee.findFirst({
      where: { id: input.employeeId, workspaceId: context.current.workspaceId },
      select: { user: { select: { id: true } } },
    });
    if (!employee) throw new ORPCError("NOT_FOUND", { message: "Team member not found" });
    const login = employee.user?.id;
    const result = await page(
      {
        OR: [
          // At this plant's terminals.
          {
            siteId: input.siteId,
            entityType: "employee",
            entityId: input.employeeId,
            action: { in: [...OPERATOR_ACTIONS] },
          },
          ...(login
            ? [
                { userId: login, action: { in: [...SIGN_IN_ACTIONS] } },
                { actorId: login, userId: null, action: { in: [...SIGN_IN_ACTIONS] } },
              ]
            : []),
        ],
      },
      input.cursor,
      input.limit,
    );
    return {
      entries: await present(result.rows, { network: true }),
      nextCursor: result.nextCursor,
      hasLogin: !!login,
    };
  });

/** The people who appear as actors in a plant's activity, for the filter. Plant ADMIN. */
export const actors = userRequired.input(z.object({ siteId: z.uuid() })).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.siteId });
  const grouped = await prisma.auditLog.groupBy({
    by: ["actorId"],
    where: { ...where({ siteId: input.siteId }, context.current.workspaceId), actorId: { not: null } },
    _count: { _all: true },
  });
  const people = await prisma.user.findMany({
    where: { id: { in: grouped.map((row) => row.actorId).filter((id): id is string => !!id) } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  return people.map((p) => ({ id: p.id, name: personName(p) })).sort((a, b) => a.name.localeCompare(b.name));
});

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * The filtered trail as CSV, newest first, up to 20,000 rows. Plant ADMIN.
 * Taking the trail out of the system is itself recorded — who, which filters,
 * how many rows — and no export is handed over without that entry.
 */
export const exportCsv = userRequired.input(filtersSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.siteId });
  const rows = await prisma.auditLog.findMany({
    where: where(input, context.current.workspaceId),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: EXPORT_MAX + 1,
  });
  const truncated = rows.length > EXPORT_MAX;
  const entries = await present(truncated ? rows.slice(0, EXPORT_MAX) : rows, { network: true });
  const header = [
    "when",
    "action",
    "who",
    "about",
    "via",
    "record type",
    "record id",
    "record",
    "changes",
    "version",
    "previous version",
    "ip",
    "user agent",
    "request",
    "details",
  ];
  const lines = entries.map((entry) =>
    [
      entry.at.toISOString(),
      entry.action,
      entry.actor?.name ?? "",
      entry.subject?.name ?? "",
      entry.via,
      entry.entityType,
      entry.entityId,
      entry.label,
      entry.changes,
      entry.versionId,
      entry.previousVersionId,
      entry.ipAddress,
      entry.userAgent,
      entry.requestId,
      entry.metadata,
    ]
      .map(csvCell)
      .join(","),
  );
  const { siteId, ...filters } = input;
  await prisma.$transaction((tx) =>
    logEvent({
      tx,
      action: "AUDIT_EXPORTED",
      siteId,
      metadata: { format: "csv", filters, rows: entries.length, truncated },
    }),
  );
  return { csv: [header.join(","), ...lines].join("\n"), rows: entries.length, truncated };
});

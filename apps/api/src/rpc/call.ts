import { z } from "zod";
import prisma, { type Prisma } from "@rw/db";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { authorizeList, authorizeReferenceRead, scopeFilter } from "@rw/auth/iam/policy";
import {
  authorizeTerminalAction,
  authorizeProductionList,
  authorizeReferenceList,
  hasProductionAdmin,
  resolveTerminalActor,
  authorizeSiteOperation,
} from "./terminal-authz.js";
import { grant } from "./authz.js";
import { call } from "@rw/services/facility/index";
import { throwServiceError, unwrap } from "./errors.js";

// ============================================================================
// Input Schemas
// ============================================================================

const severitySchema = z.enum(["INFORMATION", "ALERT", "WARNING"]);
const sourceSchema = z.enum(["MANUAL", "SYSTEM"]);

const roleIdsSchema = z.array(z.uuid()).max(100);

const definitionCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  severity: severitySchema.optional(),
  requireOpenMessage: z.boolean().optional(),
  openRoleIds: roleIdsSchema.optional(),
  answerRoleIds: roleIdsSchema.optional(),
});

const definitionUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  severity: severitySchema.optional(),
  requireOpenMessage: z.boolean().optional(),
  // Whole-list replacement; [] clears the restriction.
  openRoleIds: roleIdsSchema.optional(),
  answerRoleIds: roleIdsSchema.optional(),
});

const definitionListInputSchema = z.object({
  siteId: z.uuid().optional(),
  includeArchived: z.boolean().default(false),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const openInputSchema = z.object({
  stationId: z.uuid(),
  definitionId: z.uuid(),
  message: z.string().max(2000).optional(),
  // Display flows pass the logged-on operator explicitly; USER principals
  // resolve through their workspace membership's employee link instead.
  employeeId: z.uuid().optional(),
  operatorSessionId: z.uuid().optional(),
});

const closeInputSchema = z.object({
  id: z.uuid(),
  closeMessage: z.string().max(2000).optional(),
  employeeId: z.uuid().optional(),
  operatorSessionId: z.uuid().optional(),
});

const listActiveInputSchema = z.object({
  siteId: z.uuid().optional(),
  workcenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  definitionId: z.uuid().optional(),
  severity: severitySchema.optional(),
  limit: z.number().min(0).default(100),
  offset: z.number().min(0).default(0),
});

const searchInputSchema = z.object({
  siteId: z.uuid(),
  workcenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  definitionId: z.uuid().optional(),
  severity: severitySchema.optional(),
  source: sourceSchema.optional(),
  status: z.enum(["open", "closed", "all"]).default("all"),
  openedFrom: z.coerce.date().optional(),
  openedTo: z.coerce.date().optional(),
  sortBy: z.enum(["openedAt", "closedAt", "severity"]).default("openedAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Definition Procedures
// ============================================================================

export const definitionCreate = authRequired.input(definitionCreateInputSchema).handler(async ({ input, context }) => {
  await authorizeSiteOperation(context.iam, "configuration:write", { kind: "site", siteId: input.siteId });

  const result = await call.createDefinition(input);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const definitionList = userOrDisplayRequired
  .input(definitionListInputSchema)
  .handler(async ({ input, context }) => {
    const scope = await authorizeReferenceList(context.iam, input.siteId);
    return call.listDefinitions({ ...input, ...scopeFilter(scope) });
  });

export const definitionGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorizeReferenceRead(context.iam, { scope: { kind: "callDefinition", id: input.id } }));

  const result = await call.getDefinitionById(input.id);
  return unwrap(result, { notFoundMessage: "Call definition not found" });
});

export const definitionUpdate = authRequired.input(definitionUpdateInputSchema).handler(async ({ input, context }) => {
  await authorizeSiteOperation(context.iam, "configuration:write", { kind: "callDefinition", id: input.id });

  const { id, ...updateData } = input;
  const result = await call.updateDefinition(id, updateData);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const definitionArchive = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await authorizeSiteOperation(context.iam, "configuration:write", { kind: "callDefinition", id: input.id });

  const result = await call.archiveDefinition(input.id);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

// ============================================================================
// Call Lifecycle Procedures
// ============================================================================

export const open = userOrDisplayRequired.input(openInputSchema).handler(async ({ input, context }) => {
  const location = await authorizeTerminalAction(context.iam, {
    action: "call.open",
    scope: { kind: "station", id: input.stationId },
  });
  const actor = await resolveTerminalActor(context.iam, location, input);

  const result = await call.open({
    stationId: input.stationId,
    definitionId: input.definitionId,
    source: "MANUAL",
    message: input.message,
    openedByEmployeeId: actor.employeeId ?? undefined,
    openedByUserId: actor.userId,
  });
  if ("error" in result) throwServiceError(result);
  return { ...result.data, deduped: result.deduped };
});

export const close = userOrDisplayRequired.input(closeInputSchema).handler(async ({ input, context }) => {
  const location = await authorizeTerminalAction(context.iam, {
    action: "call.close",
    scope: { kind: "call", id: input.id },
  });
  const actor = await resolveTerminalActor(context.iam, location, input);
  const admin = await hasProductionAdmin(context.iam, location);

  const result = await call.close({
    id: input.id,
    closeMessage: input.closeMessage,
    closedByEmployeeId: actor.employeeId ?? undefined,
    closedByUserId: actor.userId,
    bypassAnswerRoles: admin,
  });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const get = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await authorizeTerminalAction(context.iam, { action: "production.read", scope: { kind: "call", id: input.id } });

  const result = await call.getById(input.id);
  return unwrap(result, { notFoundMessage: "Call not found" });
});

export const listActive = userOrDisplayRequired.input(listActiveInputSchema).handler(async ({ input, context }) => {
  const scope = await authorizeProductionList(context.iam, input);
  if (scope.workcenterIds)
    return scopedCallPage(
      {
        siteId: scope.siteId,
        deletedAt: null,
        closedAt: null,
        stationId: scope.stationId,
        definitionId: input.definitionId,
        severity: input.severity,
        workcenterId: { in: scope.workcenterIds },
        ...(input.workcenterId ? { AND: [{ workcenterId: input.workcenterId }] } : {}),
      },
      input,
      { openedAt: "desc" },
    );
  return call.listActive({
    ...input,
    ...scopeFilter(scope),
    workcenterIds: scope.workcenterIds,
    stationId: scope.stationId,
  });
});

export const search = authRequired.input(searchInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorizeList(context.iam, { permission: "production:read", requestedSiteId: input.siteId }),
  );
  if (scope.workcenterIds)
    return scopedCallPage(
      {
        siteId: scope.siteId,
        deletedAt: null,
        stationId: input.stationId,
        definitionId: input.definitionId,
        severity: input.severity,
        source: input.source,
        workcenterId: { in: scope.workcenterIds },
        ...(input.workcenterId ? { AND: [{ workcenterId: input.workcenterId }] } : {}),
        ...(input.status === "open"
          ? { closedAt: null }
          : input.status === "closed"
            ? { closedAt: { not: null } }
            : {}),
        openedAt: { gte: input.openedFrom, lte: input.openedTo },
      },
      input,
      { [input.sortBy]: input.sortDir },
    );
  return call.search({ ...input, workcenterIds: scope.workcenterIds });
});

async function scopedCallPage(
  where: Prisma.CallWhereInput,
  page: { limit: number; offset: number },
  orderBy: Prisma.CallOrderByWithRelationInput,
) {
  const include = {
    definition: { select: { id: true, name: true, severity: true } },
    station: { select: { id: true, name: true } },
    workcenter: { select: { id: true, name: true } },
    jobVersion: { select: { name: true } },
    shiftInstance: { select: { id: true, shiftName: true } },
    openedByEmployee: { select: { id: true, version: { select: { firstName: true, lastName: true } } } },
    closedByEmployee: { select: { id: true, version: { select: { firstName: true, lastName: true } } } },
  } as const;
  const [data, total] = await Promise.all([
    prisma.call.findMany({
      where,
      include,
      orderBy,
      ...(page.limit > 0 ? { take: page.limit } : {}),
      skip: page.offset,
    }),
    prisma.call.count({ where }),
  ]);
  return { data, total, limit: page.limit, offset: page.offset };
}

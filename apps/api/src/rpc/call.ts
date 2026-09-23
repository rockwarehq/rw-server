import { z } from "zod";
import { userRequired, userOrDisplayRequired } from "./middleware.js";
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
});

const closeInputSchema = z.object({
  id: z.uuid(),
  closeMessage: z.string().max(2000).optional(),
  employeeId: z.uuid().optional(),
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

export const definitionCreate = userRequired.input(definitionCreateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { site: input.siteId });

  const result = await call.createDefinition(input);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const definitionList = userOrDisplayRequired
  .input(definitionListInputSchema)
  .handler(async ({ input, context }) => {
    const scope = context.access.list("VIEW", input.siteId);
    return call.listDefinitions({ ...input, siteId: scope.siteId });
  });

export const definitionGet = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { callDefinition: input.id });

  const result = await call.getDefinitionById(input.id);
  return unwrap(result, { notFoundMessage: "Call definition not found" });
});

export const definitionUpdate = userRequired.input(definitionUpdateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { callDefinition: input.id });

  const { id, ...updateData } = input;
  const result = await call.updateDefinition(id, updateData);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const definitionArchive = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { callDefinition: input.id });

  const result = await call.archiveDefinition(input.id);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

// ============================================================================
// Call Lifecycle Procedures
// ============================================================================

export const open = userOrDisplayRequired.input(openInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { station: input.stationId });

  const result = await call.open({
    stationId: input.stationId,
    definitionId: input.definitionId,
    source: "MANUAL",
    message: input.message,
    openedByEmployeeId: input.employeeId,
    openedByUserId: context.current.kind === "user" ? context.current.user.id : undefined,
  });
  if ("error" in result) throwServiceError(result);
  return { ...result.data, deduped: result.deduped };
});

export const close = userOrDisplayRequired.input(closeInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { call: input.id });

  // Everyone past this gate may skip the definition's answer roles: users
  // here hold MANAGE, and displays always could (unchanged from before
  // buckets). Whether answer roles should ever bind is an open product
  // question.

  const result = await call.close({
    id: input.id,
    closeMessage: input.closeMessage,
    closedByEmployeeId: input.employeeId,
    closedByUserId: context.current.kind === "user" ? context.current.user.id : undefined,
    bypassAnswerRoles: true,
  });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const get = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { call: input.id });

  const result = await call.getById(input.id);
  return unwrap(result, { notFoundMessage: "Call not found" });
});

export const listActive = userOrDisplayRequired.input(listActiveInputSchema).handler(async ({ input, context }) => {
  const scope = context.access.list("VIEW", input.siteId, "WORKCENTER");
  return call.listActive({ ...input, siteId: scope.siteId, workcenterIds: scope.workcenterIds });
});

export const search = userRequired.input(searchInputSchema).handler(async ({ input, context }) => {
  const scope = context.access.list("VIEW", input.siteId, "WORKCENTER");
  return call.search({ ...input, workcenterIds: scope.workcenterIds });
});

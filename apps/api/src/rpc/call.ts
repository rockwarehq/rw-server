import { z } from "zod";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { authorize, authorizeList, scopeFilter } from "@rw/auth/iam/policy";
import { Principal } from "../auth/index.js";
import { grant } from "./authz.js";
import { call } from "@rw/services/facility/index";
import { throwServiceError, unwrap } from "./errors.js";

// ============================================================================
// Input Schemas
// ============================================================================

const severitySchema = z.enum(["INFORMATION", "ALERT", "WARNING"]);
const sourceSchema = z.enum(["MANUAL", "SYSTEM"]);

const definitionCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  severity: severitySchema.optional(),
});

const definitionUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  severity: severitySchema.optional(),
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

export const definitionCreate = authRequired.input(definitionCreateInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "calls:admin", scope: { kind: "site", siteId: input.siteId } }));

  const result = await call.createDefinition(input);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const definitionList = userOrDisplayRequired
  .input(definitionListInputSchema)
  .handler(async ({ input, context }) => {
    const scope = grant(await authorizeList(context.iam, { permission: "calls:read", requestedSiteId: input.siteId }));
    return call.listDefinitions({ ...input, ...scopeFilter(scope) });
  });

export const definitionGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "calls:read", scope: { kind: "callDefinition", id: input.id } }));

  const result = await call.getDefinitionById(input.id);
  return unwrap(result, { notFoundMessage: "Call definition not found" });
});

export const definitionUpdate = authRequired.input(definitionUpdateInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "calls:admin", scope: { kind: "callDefinition", id: input.id } }));

  const { id, ...updateData } = input;
  const result = await call.updateDefinition(id, updateData);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const definitionArchive = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "calls:admin", scope: { kind: "callDefinition", id: input.id } }));

  const result = await call.archiveDefinition(input.id);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

// ============================================================================
// Call Lifecycle Procedures
// ============================================================================

export const open = userOrDisplayRequired.input(openInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "calls:write", scope: { kind: "station", id: input.stationId } }));

  const result = await call.open({
    stationId: input.stationId,
    definitionId: input.definitionId,
    source: "MANUAL",
    message: input.message,
    openedByEmployeeId: input.employeeId,
    openedByUserId: context.iam.principal === Principal.USER ? context.iam.id : undefined,
  });
  if ("error" in result) throwServiceError(result);
  return { ...result.data, deduped: result.deduped };
});

export const close = userOrDisplayRequired.input(closeInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "calls:write", scope: { kind: "call", id: input.id } }));

  // Future answering restrictions (e.g. definition-level answerRoles) slot in
  // here: resolve the acting employee, check against the definition, deny
  // before calling the service.
  const result = await call.close({
    id: input.id,
    closeMessage: input.closeMessage,
    closedByEmployeeId: input.employeeId,
    closedByUserId: context.iam.principal === Principal.USER ? context.iam.id : undefined,
  });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const get = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "calls:read", scope: { kind: "call", id: input.id } }));

  const result = await call.getById(input.id);
  return unwrap(result, { notFoundMessage: "Call not found" });
});

export const listActive = userOrDisplayRequired.input(listActiveInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorizeList(context.iam, { permission: "calls:read", requestedSiteId: input.siteId }));
  return call.listActive({ ...input, ...scopeFilter(scope) });
});

export const search = authRequired.input(searchInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "calls:read", scope: { kind: "site", siteId: input.siteId } }));
  return call.search(input);
});

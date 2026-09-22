import { z } from "zod";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { authorize, authorizeReferenceRead, scopeFilter } from "@rw/auth/iam/policy";
import prisma from "@rw/db";
import {
  assertRelatedSite,
  assertProductionLinks,
  authorizeTerminalAction,
  authorizeProductionList,
  authorizeReferenceList,
  authorizeSiteOperation,
  terminalForbidden,
} from "./terminal-authz.js";
import { grant } from "./authz.js";
import * as dispositionService from "@rw/services/inventory/disposition";
import * as dispositionReasonService from "@rw/services/inventory/disposition-reason";
import * as dispositionLogService from "@rw/services/inventory/disposition-log";
import { type CodeOverrides, throwServiceError, unwrap } from "./errors.js";

// The log handlers historically mapped DISPOSITION_REASON_NOT_LINKED to
// CONFLICT (only the bare NOT_LINKED code is in the shared exact table, so the
// default would be BAD_REQUEST). Pinned — observable error codes are API.
const dispositionLogOverrides: CodeOverrides = {
  DISPOSITION_REASON_NOT_LINKED: "CONFLICT",
};

// ============================================================================
// ItemDisposition Input Schemas
// ============================================================================

const dispositionCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
});

const dispositionUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const dispositionListInputSchema = z.object({
  siteId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// ItemDispositionReason Input Schemas
// ============================================================================

const reasonCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  itemDispositionIds: z.array(z.uuid()).optional(),
  labelIds: z.array(z.uuid()).max(50).optional(),
});

const reasonUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  itemDispositionIds: z.array(z.uuid()).optional(),
  // Replaces the code's whole label list with this one.
  labelIds: z.array(z.uuid()).max(50).optional(),
});

const reasonListInputSchema = z.object({
  siteId: z.uuid().optional(),
  itemDispositionId: z.uuid().optional(),
  // Only return codes that have at least one of these labels.
  labelIds: z.array(z.uuid()).max(50).optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// ItemDispositionLog Input Schemas
// ============================================================================

const logRecordInputSchema = z.object({
  siteId: z.uuid(),
  stationId: z.uuid(),
  workcenterId: z.uuid().optional(),
  productId: z.uuid(),
  jobId: z.uuid().optional(),
  toolCavityId: z.uuid().optional(),
  quantity: z
    .number()
    .refine((q) => q !== 0, { message: "quantity must be non-zero" })
    .optional(),
  itemDispositionId: z.uuid(),
  dispositionReasonId: z.uuid(),
  cycleId: z.uuid().optional(),
  shiftInstanceId: z.uuid().optional(),
});

const logCreateInputSchema = z.object({
  siteId: z.uuid(),
  stationId: z.uuid(),
  quantity: z.number().positive().optional(),
  itemDispositionId: z.uuid(),
  dispositionReasonId: z.uuid(),
  cycleId: z.uuid().optional(),
  shiftInstanceId: z.uuid().optional(),
  productVersionId: z.uuid(),
  stationVersionId: z.uuid().optional(),
  jobProductVersionId: z.uuid().optional(),
  toolVersionId: z.uuid().optional(),
  toolCavityVersionId: z.uuid().optional(),
});

const logUpdateInputSchema = z.object({
  id: z.uuid(),
  quantity: z.number().positive().optional(),
  itemDispositionId: z.uuid().nullable().optional(),
  dispositionReasonId: z.uuid().nullable().optional(),
});

const logListInputSchema = z.object({
  siteId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  shiftInstanceId: z.uuid().optional(),
  dispositionReasonId: z.uuid().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// ItemDisposition Procedures
// ============================================================================

export const dispositionCreate = authRequired
  .input(dispositionCreateInputSchema)
  .handler(async ({ input, context }) => {
    await authorizeSiteOperation(context.iam, "configuration:write", { kind: "site", siteId: input.siteId });

    return unwrap(await dispositionService.create(input));
  });

export const dispositionList = userOrDisplayRequired
  .input(dispositionListInputSchema)
  .handler(async ({ input, context }) => {
    const scope = await authorizeReferenceList(context.iam, input.siteId);
    return dispositionService.list({ ...input, ...scopeFilter(scope) });
  });

export const dispositionGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorizeReferenceRead(context.iam, { scope: { kind: "disposition", id: input.id } }));

  return unwrap(await dispositionService.getById(input.id), { notFoundMessage: "Disposition not found" });
});

export const dispositionUpdate = authRequired
  .input(dispositionUpdateInputSchema)
  .handler(async ({ input, context }) => {
    await authorizeSiteOperation(context.iam, "configuration:write", { kind: "disposition", id: input.id });

    const { id, ...updateData } = input;
    return unwrap(await dispositionService.update(id, updateData));
  });

export const dispositionDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await authorizeSiteOperation(context.iam, "configuration:write", { kind: "disposition", id: input.id });

  const result = await dispositionService.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

// ============================================================================
// ItemDispositionReason Procedures
// ============================================================================

export const reasonCreate = authRequired.input(reasonCreateInputSchema).handler(async ({ input, context }) => {
  await authorizeSiteOperation(context.iam, "configuration:write", { kind: "site", siteId: input.siteId });

  const result = await dispositionReasonService.create(input);
  if ("error" in result && result.error) throwServiceError(result);
  return result.data;
});

export const reasonList = userOrDisplayRequired.input(reasonListInputSchema).handler(async ({ input, context }) => {
  const scope = await authorizeReferenceList(context.iam, input.siteId);
  return dispositionReasonService.list({ ...input, ...scopeFilter(scope) });
});

export const reasonGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorizeReferenceRead(context.iam, { scope: { kind: "dispositionReason", id: input.id } }));

  return unwrap(await dispositionReasonService.getById(input.id), {
    notFoundMessage: "Disposition reason not found",
  });
});

export const reasonUpdate = authRequired.input(reasonUpdateInputSchema).handler(async ({ input, context }) => {
  await authorizeSiteOperation(context.iam, "configuration:write", { kind: "dispositionReason", id: input.id });

  const { id, ...updateData } = input;
  const result = await dispositionReasonService.update(id, updateData);
  if ("error" in result && result.error) throwServiceError(result);
  return result.data;
});

export const reasonDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await authorizeSiteOperation(context.iam, "configuration:write", { kind: "dispositionReason", id: input.id });

  const result = await dispositionReasonService.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

// ============================================================================
// ItemDispositionLog Procedures
// ============================================================================

export const logRecord = userOrDisplayRequired.input(logRecordInputSchema).handler(async ({ input, context }) => {
  const location = await authorizeTerminalAction(context.iam, {
    action: "disposition.record",
    scope: { kind: "station", id: input.stationId },
  });
  await assertProductionLinks(location, input);
  await assertRelatedSite(location.siteId, [
    { kind: "product", id: input.productId },
    ...(input.jobId ? [{ kind: "job" as const, id: input.jobId }] : []),
    ...(input.toolCavityId ? [{ kind: "toolCavity" as const, id: input.toolCavityId }] : []),
  ]);

  const result = await dispositionLogService.record(input);
  if ("error" in result) throwServiceError(result, dispositionLogOverrides);
  return result.data;
});

export const logCreate = authRequired.input(logCreateInputSchema).handler(async ({ input, context }) => {
  const location = await authorizeTerminalAction(context.iam, {
    action: "disposition.record",
    scope: { kind: "station", id: input.stationId },
  });
  await assertProductionLinks(location, input);
  const productVersion = await prisma.productVersion.findUnique({
    where: { id: input.productVersionId },
    select: { productId: true },
  });
  if (!productVersion) terminalForbidden("PRODUCT_VERSION_INVALID", "Product version not found");
  await assertRelatedSite(location.siteId, [{ kind: "product", id: productVersion.productId }]);
  if (input.stationVersionId) {
    const version = await prisma.stationVersion.findUnique({
      where: { id: input.stationVersionId },
      select: { stationId: true },
    });
    if (version?.stationId !== input.stationId)
      terminalForbidden("STATION_VERSION_MISMATCH", "Station version belongs to another station");
  }
  if (input.jobProductVersionId) {
    const version = await prisma.jobProductVersion.findUnique({
      where: { id: input.jobProductVersionId },
      select: { jobProduct: { select: { productId: true, jobId: true } } },
    });
    if (!version || version.jobProduct.productId !== productVersion.productId)
      terminalForbidden("JOB_PRODUCT_VERSION_MISMATCH", "Job item does not match the product");
    await assertRelatedSite(location.siteId, [{ kind: "job", id: version.jobProduct.jobId }]);
  }
  if (input.toolVersionId) {
    const version = await prisma.toolVersion.findUnique({
      where: { id: input.toolVersionId },
      select: { toolId: true },
    });
    if (!version) terminalForbidden("TOOL_VERSION_INVALID", "Tool version not found");
    await assertRelatedSite(location.siteId, [{ kind: "tool", id: version.toolId }]);
  }
  if (input.toolCavityVersionId) {
    const version = await prisma.toolCavityVersion.findUnique({
      where: { id: input.toolCavityVersionId },
      select: { toolCavityId: true },
    });
    if (!version) terminalForbidden("TOOL_CAVITY_VERSION_INVALID", "Tool cavity version not found");
    await assertRelatedSite(location.siteId, [{ kind: "toolCavity", id: version.toolCavityId }]);
  }

  const result = await dispositionLogService.create(input);
  if ("error" in result) throwServiceError(result, dispositionLogOverrides);
  return result.data;
});

export const logList = userOrDisplayRequired.input(logListInputSchema).handler(async ({ input, context }) => {
  const scope = await authorizeProductionList(context.iam, input);
  if (!scope.workcenterIds)
    return dispositionLogService.list({ ...input, ...scopeFilter(scope), stationId: scope.stationId });
  // Filter before pagination. The service's unscoped list is also used by internal callers.
  const where = {
    siteId: scope.siteId,
    deletedAt: null,
    stationId: scope.stationId,
    workcenterId: { in: scope.workcenterIds },
    shiftInstanceId: input.shiftInstanceId,
    dispositionReasonId: input.dispositionReasonId,
    createdAt: { gte: input.startDate, lte: input.endDate },
  };
  const include = {
    station: { select: { id: true, name: true } },
    itemDisposition: { select: { id: true, name: true } },
    dispositionReason: { select: { id: true, name: true } },
    productVersion: { select: { id: true, version: true, name: true, sku: true, productId: true } },
    stationVersion: { select: { id: true, version: true } },
    toolVersion: { select: { id: true, version: true, name: true } },
    toolCavityVersion: { select: { id: true, version: true, name: true, toolCavityId: true } },
    jobProductVersion: { select: { id: true, version: true, jobProduct: { select: { jobId: true } } } },
    productMaterialVersions: {
      select: {
        id: true,
        version: true,
        weight: true,
        weightUnits: true,
        itemCost: true,
        materialVersion: { select: { id: true, version: true, name: true, materialNumber: true, shortCode: true } },
      },
    },
    shiftInstance: { select: { id: true, shiftName: true, businessDate: true, startTime: true, endTime: true } },
    cycle: { select: { id: true } },
  } as const;
  const [data, total] = await Promise.all([
    prisma.itemDispositionLog.findMany({
      where,
      include,
      ...(input.limit > 0 ? { take: input.limit } : {}),
      skip: input.offset,
      orderBy: { createdAt: "desc" },
    }),
    prisma.itemDispositionLog.count({ where }),
  ]);
  return { data, total, limit: input.limit, offset: input.offset };
});

export const logGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await authorizeTerminalAction(context.iam, {
    action: "production.read",
    scope: { kind: "dispositionLog", id: input.id },
  });

  return unwrap(await dispositionLogService.getById(input.id), { notFoundMessage: "Disposition log not found" });
});

export const logUpdate = authRequired.input(logUpdateInputSchema).handler(async ({ input, context }) => {
  await authorizeTerminalAction(context.iam, {
    action: "disposition.record",
    scope: { kind: "dispositionLog", id: input.id },
  });

  const { id, ...updateData } = input;
  const result = await dispositionLogService.update(id, updateData);
  if ("error" in result) throwServiceError(result, dispositionLogOverrides);
  return result.data;
});

export const logDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, { permission: "production:admin", scope: { kind: "dispositionLog", id: input.id } }),
  );

  const result = await dispositionLogService.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

import { z } from "zod";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
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
  processTypeId: z.uuid().optional(),
});

const reasonUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  itemDispositionIds: z.array(z.uuid()).optional(),
  processTypeId: z.uuid().nullable().optional(),
});

const reasonListInputSchema = z.object({
  siteId: z.uuid().optional(),
  itemDispositionId: z.uuid().optional(),
  processTypeId: z.uuid().optional(),
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
    .int()
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
  quantity: z.number().int().min(1).optional(),
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
  quantity: z.number().int().min(1).optional(),
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

export const dispositionCreate = authRequired.input(dispositionCreateInputSchema).handler(async ({ input }) => {
  return unwrap(await dispositionService.create(input));
});

export const dispositionList = userOrDisplayRequired.input(dispositionListInputSchema).handler(async ({ input }) => {
  return dispositionService.list(input);
});

export const dispositionGet = authRequired.input(idInputSchema).handler(async ({ input }) => {
  return unwrap(await dispositionService.getById(input.id), { notFoundMessage: "Disposition not found" });
});

export const dispositionUpdate = authRequired.input(dispositionUpdateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  return unwrap(await dispositionService.update(id, updateData));
});

export const dispositionDelete = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await dispositionService.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

// ============================================================================
// ItemDispositionReason Procedures
// ============================================================================

export const reasonCreate = authRequired.input(reasonCreateInputSchema).handler(async ({ input }) => {
  const result = await dispositionReasonService.create(input);
  if ("error" in result && result.error) throwServiceError(result);
  return result.data;
});

export const reasonList = userOrDisplayRequired.input(reasonListInputSchema).handler(async ({ input }) => {
  return dispositionReasonService.list(input);
});

export const reasonGet = authRequired.input(idInputSchema).handler(async ({ input }) => {
  return unwrap(await dispositionReasonService.getById(input.id), {
    notFoundMessage: "Disposition reason not found",
  });
});

export const reasonUpdate = authRequired.input(reasonUpdateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  const result = await dispositionReasonService.update(id, updateData);
  if ("error" in result && result.error) throwServiceError(result);
  return result.data;
});

export const reasonDelete = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await dispositionReasonService.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

// ============================================================================
// ItemDispositionLog Procedures
// ============================================================================

export const logRecord = userOrDisplayRequired.input(logRecordInputSchema).handler(async ({ input }) => {
  const result = await dispositionLogService.record(input);
  if ("error" in result && result.error) throwServiceError(result, dispositionLogOverrides);
  return result.data;
});

export const logCreate = authRequired.input(logCreateInputSchema).handler(async ({ input }) => {
  const result = await dispositionLogService.create(input);
  if ("error" in result && result.error) throwServiceError(result, dispositionLogOverrides);
  return result.data;
});

export const logList = userOrDisplayRequired.input(logListInputSchema).handler(async ({ input }) => {
  return dispositionLogService.list(input);
});

export const logGet = authRequired.input(idInputSchema).handler(async ({ input }) => {
  return unwrap(await dispositionLogService.getById(input.id), { notFoundMessage: "Disposition log not found" });
});

export const logUpdate = authRequired.input(logUpdateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  const result = await dispositionLogService.update(id, updateData);
  if ("error" in result && result.error) throwServiceError(result, dispositionLogOverrides);
  return result.data;
});

export const logDelete = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await dispositionLogService.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

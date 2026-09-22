import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { scopeFilter } from "@rw/auth/iam/policy";
import {
  authorizePhysicalTarget as authorize,
  authorizePhysicalList as authorizeList,
  authorizePhysicalReference as authorizeReferenceRead,
} from "../api/authz.js";
import { grant } from "./authz.js";
import { shift } from "@rw/services/facility/index";
import { type CodeOverrides, throwServiceError, unwrap } from "./errors.js";

// Pinned historical mappings (observable error codes are API — see errors.ts).
// The assignment procedures fell through to BAD_REQUEST for definition-related
// codes and used CONFLICT for PATTERN_ALREADY_ASSIGNED before the shared mapper
// existed; mapServiceCode would return NOT_FOUND / CONFLICT / BAD_REQUEST
// respectively.
const ASSIGNMENT_OVERRIDES: CodeOverrides = {
  SHIFT_DEFINITION_NOT_FOUND: "BAD_REQUEST",
  DEFINITION_PATTERN_MISMATCH: "BAD_REQUEST",
};
const ASSIGNMENT_CREATE_OVERRIDES: CodeOverrides = {
  ...ASSIGNMENT_OVERRIDES,
  PATTERN_ALREADY_ASSIGNED: "CONFLICT",
};

// ============================================================================
// Current Shift / Business Date
// ============================================================================

const currentInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
});

export const current = userOrDisplayRequired.input(currentInputSchema).handler(async ({ input, context }) => {
  grant(await authorizeReferenceRead(context.iam, { scope: siteScope(input.siteId) }));

  const result = await shift.current.getCurrentShift(input.siteId, input.workCenterId);
  return unwrap(result);
});

// ============================================================================
// ShiftPattern Input Schemas
// ============================================================================

const patternCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  totalDaysInRotation: z.number().int().min(1).optional(),
  startOnDayOfWeek: z.string().optional(),
  useEndDateForBusinessDate: z.boolean().optional(),
});

const patternUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  totalDaysInRotation: z.number().int().min(1).optional(),
  startOnDayOfWeek: z.string().nullable().optional(),
  useEndDateForBusinessDate: z.boolean().optional(),
});

const patternListInputSchema = z.object({
  siteId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const duplicateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
});

// ============================================================================
// ShiftDefinition Input Schemas
// ============================================================================

const definitionCreateInputSchema = z.object({
  patternId: z.uuid(),
  dayOfRotation: z.number().int().min(1),
  sortOrder: z.number().int().min(1),
  startDayOffset: z.number().int().min(-1).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, "Must be HH:mm format"),
  durationHrs: z.number().positive(),
  shiftName: z.string().min(1),
  isScheduled: z.boolean().optional(),
});

const definitionUpdateInputSchema = z.object({
  id: z.uuid(),
  dayOfRotation: z.number().int().min(1).optional(),
  sortOrder: z.number().int().min(1).optional(),
  startDayOffset: z.number().int().min(-1).optional(),
  startTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Must be HH:mm format")
    .optional(),
  durationHrs: z.number().positive().optional(),
  shiftName: z.string().min(1).optional(),
  isScheduled: z.boolean().optional(),
});

const definitionListInputSchema = z.object({
  patternId: z.uuid(),
  dayOfRotation: z.number().int().min(1).optional(),
});

// ============================================================================
// ShiftAssignment Input Schemas
// ============================================================================

const assignmentCreateInputSchema = z.object({
  patternId: z.uuid(),
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  rotationStartDate: z.coerce.date(),
  rotationEndDate: z.coerce.date().optional(),
  rotationStartDefinitionId: z.uuid().optional(),
});

const assignmentUpdateInputSchema = z.object({
  id: z.uuid(),
  rotationStartDate: z.coerce.date().optional(),
  rotationEndDate: z.coerce.date().nullable().optional(),
  rotationStartDefinitionId: z.uuid().nullable().optional(),
});

const assignmentListInputSchema = z.object({
  siteId: z.uuid().optional(),
  workCenterId: z.uuid().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// ShiftPattern Procedures
// ============================================================================

export const patternCreate = authRequired.input(patternCreateInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "planning:write", scope: siteScope(input.siteId) }));

  const result = await shift.pattern.create(input);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/** A calendar year and a bit: the month view never asks for more. */
const MAX_PREVIEW_DAYS = 400;
const MS_PER_DAY = 86_400_000;

/** Site scope for the policy call each handler makes inline. */
const siteScope = (siteId: string) => ({ kind: "site", siteId }) as const;

export const patternList = authRequired.input(patternListInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorizeList(context.iam, { permission: "planning:read", requestedSiteId: input.siteId }));
  return shift.pattern.list({ ...input, ...scopeFilter(scope) });
});

export const patternGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "planning:read", scope: { kind: "shiftPattern", id: input.id } }));

  const result = await shift.pattern.getById(input.id);
  return unwrap(result, { notFoundMessage: "Shift pattern not found" });
});

export const patternUpdate = authRequired.input(patternUpdateInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "planning:write", scope: { kind: "shiftPattern", id: input.id } }));

  const { id, ...updateData } = input;
  const result = await shift.pattern.update(id, updateData);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const patternDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "planning:write", scope: { kind: "shiftPattern", id: input.id } }));

  const result = await shift.pattern.remove(input.id);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

export const patternDuplicate = authRequired.input(duplicateInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "planning:write", scope: { kind: "shiftPattern", id: input.id } }));

  const result = await shift.pattern.duplicate(input.id, input.name);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

// ============================================================================
// ShiftDefinition Procedures
// ============================================================================

export const definitionCreate = authRequired.input(definitionCreateInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, {
      permission: "planning:write",
      scope: { kind: "shiftPattern", id: input.patternId },
    }),
  );

  const result = await shift.definition.create(input);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const definitionList = authRequired.input(definitionListInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, { permission: "planning:read", scope: { kind: "shiftPattern", id: input.patternId } }),
  );

  return shift.definition.list(input);
});

export const definitionGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, { permission: "planning:read", scope: { kind: "shiftDefinition", id: input.id } }),
  );

  const result = await shift.definition.getById(input.id);
  return unwrap(result, { notFoundMessage: "Shift definition not found" });
});

export const definitionUpdate = authRequired.input(definitionUpdateInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, { permission: "planning:write", scope: { kind: "shiftDefinition", id: input.id } }),
  );

  const { id, ...updateData } = input;
  const result = await shift.definition.update(id, updateData);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const definitionDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, { permission: "planning:write", scope: { kind: "shiftDefinition", id: input.id } }),
  );

  const result = await shift.definition.remove(input.id);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

// ============================================================================
// ShiftAssignment Procedures
// ============================================================================

export const assignmentCreate = authRequired.input(assignmentCreateInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "planning:write", scope: siteScope(input.siteId) }));

  const result = await shift.assignment.create(input);
  if (result.error !== undefined) throwServiceError(result, ASSIGNMENT_CREATE_OVERRIDES);
  return result.data;
});

export const assignmentList = authRequired.input(assignmentListInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorizeList(context.iam, { permission: "planning:read", requestedSiteId: input.siteId }));
  return shift.assignment.list({ ...input, ...scopeFilter(scope) });
});

export const assignmentGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, { permission: "planning:read", scope: { kind: "shiftAssignment", id: input.id } }),
  );

  const result = await shift.assignment.getById(input.id);
  return unwrap(result, { notFoundMessage: "Shift assignment not found" });
});

export const assignmentUpdate = authRequired.input(assignmentUpdateInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, { permission: "planning:write", scope: { kind: "shiftAssignment", id: input.id } }),
  );

  const { id, ...updateData } = input;
  const result = await shift.assignment.update(id, updateData);
  if (result.error !== undefined) throwServiceError(result, ASSIGNMENT_OVERRIDES);
  return result.data;
});

const assignmentPreviewInputSchema = z.object({
  id: z.uuid(),
  from: z.iso.date(),
  to: z.iso.date(),
});

/** Calendar rows for [from, to]: what materialization would produce, overrides applied. Read-only. */
export const assignmentPreview = authRequired
  .input(assignmentPreviewInputSchema)
  .handler(async ({ input, context }) => {
    grant(
      await authorize(context.iam, { permission: "planning:read", scope: { kind: "shiftAssignment", id: input.id } }),
    );
    const from = new Date(`${input.from}T00:00:00Z`);
    const to = new Date(`${input.to}T00:00:00Z`);
    if (to < from || to.getTime() - from.getTime() > MAX_PREVIEW_DAYS * MS_PER_DAY) {
      throw new ORPCError("BAD_REQUEST", { message: `Preview range must be 0-${MAX_PREVIEW_DAYS} days` });
    }
    const { today, now, rows } = await shift.previewShiftInstances(input.id, from, to);
    // `now` too: a client adding a shift must know whether the window it names
    // has already run (an amendment) or has not (an override).
    return { today, now, rows: rows.map(({ assignmentId: _a, siteId: _s, ...row }) => row) };
  });

export const assignmentUnpublish = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, { permission: "planning:write", scope: { kind: "shiftAssignment", id: input.id } }),
  );

  const result = await shift.assignment.unpublish(input.id);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

// ============================================================================
// ShiftOverride Procedures
// ============================================================================

const businessDateSchema = z.iso.date().transform((d) => new Date(`${d}T00:00:00Z`));

const overrideCreateInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().nullable().optional(),
  businessDate: businessDateSchema,
  shiftName: z.string().min(1).nullable().optional(),
  startTime: z.coerce.date().nullable().optional(),
  endTime: z.coerce.date().nullable().optional(),
  isScheduled: z.boolean().nullable().optional(),
  note: z.string().min(1).nullable().optional(),
});

const overrideUpdateInputSchema = z.object({
  id: z.uuid(),
  startTime: z.coerce.date().nullable().optional(),
  endTime: z.coerce.date().nullable().optional(),
  isScheduled: z.boolean().nullable().optional(),
  note: z.string().min(1).nullable().optional(),
});

const overrideListInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().nullable().optional(),
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
});

/** An override is authorized through its site, so the row is read first. */
async function loadOverride(id: string) {
  return unwrap(await shift.override.getById(id), { notFoundMessage: "Shift override not found" });
}

export const overrideCreate = authRequired.input(overrideCreateInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "planning:write", scope: siteScope(input.siteId) }));

  return unwrap(await shift.override.create(input));
});

export const overrideList = authRequired.input(overrideListInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "planning:read", scope: siteScope(input.siteId) }));
  return shift.override.list(input);
});

export const overrideGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const override = await loadOverride(input.id);
  grant(await authorize(context.iam, { permission: "planning:read", scope: siteScope(override.siteId) }));
  return override;
});

export const overrideUpdate = authRequired.input(overrideUpdateInputSchema).handler(async ({ input, context }) => {
  const override = await loadOverride(input.id);
  grant(await authorize(context.iam, { permission: "planning:write", scope: siteScope(override.siteId) }));
  const { id, ...updateData } = input;
  return unwrap(await shift.override.update(id, updateData));
});

export const overrideDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const override = await loadOverride(input.id);
  grant(await authorize(context.iam, { permission: "planning:write", scope: siteScope(override.siteId) }));
  const result = await shift.override.remove(input.id);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

// ============================================================================
// ShiftAmendment Procedures — corrections to shifts that already started
// ============================================================================

// An amendment is an override of a day that has run: same shape, and the shift
// it corrects must be named.
const amendmentCreateInputSchema = overrideCreateInputSchema.extend({ shiftName: z.string().min(1) });

/** An amendment is authorized through its site, so the row is read first. */
async function loadAmendment(id: string) {
  return unwrap(await shift.amend.getById(id), { notFoundMessage: "Shift amendment not found" });
}

export const amendmentCreate = authRequired.input(amendmentCreateInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "planning:write", scope: siteScope(input.siteId) }));
  return unwrap(await shift.amend.amendShift({ ...input, actorUserId: context.iam.id }));
});

export const amendmentList = authRequired.input(overrideListInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "planning:read", scope: siteScope(input.siteId) }));
  return shift.amend.listShiftAmendments(input);
});

export const amendmentUndo = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const amendment = await loadAmendment(input.id);
  grant(await authorize(context.iam, { permission: "planning:write", scope: siteScope(amendment.siteId) }));
  return unwrap(await shift.amend.undoShiftAmendment(input.id, context.iam.id));
});

export const amendmentRetry = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const amendment = await loadAmendment(input.id);
  grant(await authorize(context.iam, { permission: "planning:write", scope: siteScope(amendment.siteId) }));
  return unwrap(await shift.amend.retryShiftAmendment(input.id));
});

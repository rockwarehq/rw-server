import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { userRequired, processorRequired, userOrDisplayRequired } from "./middleware.js";
import { station } from "@rw/services/facility/index";
import { amendJobHistory as amendJobHistoryService, listAmendments, retryRebuild } from "@rw/services/history/index";
import { type CodeOverrides, throwServiceError } from "./errors.js";

// Pinned historical mappings (observable error codes are API — see errors.ts):
// these codes fell through to BAD_REQUEST here before the shared mapper existed,
// while mapServiceCode would return NOT_FOUND (ACTION_NOT_FOUND) or CONFLICT
// (SITE_MISMATCH on update).
const UPDATE_OVERRIDES: CodeOverrides = {
  SITE_MISMATCH: "BAD_REQUEST",
};
const EVENT_ACTION_OVERRIDES: CodeOverrides = { ACTION_NOT_FOUND: "BAD_REQUEST" };

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  siteId: z.uuid(),
  workcenterId: z.uuid().optional(),
  labelIds: z.array(z.uuid()).max(50).optional(),
  // Config fields (stored on StationVersion)
  standardCycle: z.number().positive().optional(),
  cycleMode: z.enum(["DISCRETE", "QUANTITY_PER_CYCLE", "QUANTITY_PER_INTERVAL"]).optional(),
  quantityUnit: z.string().optional(),
  standardRate: z.number().positive().nullable().optional(),
  standardRateUnit: z.string().optional(),
  standardRatePeriod: z.enum(["SECOND", "MINUTE", "HOUR"]).optional(),
  standardQuantity: z.number().positive().nullable().optional(),
  downtimeDetect: z.number().positive().optional(),
  downtimeDetectUnit: z.enum(["SECONDS"]).optional(),
  slowDetect: z.number().positive().optional(),
  slowDetectUnit: z.enum(["PERCENTAGE"]).optional(),
  inLineCalculations: z.boolean().optional(),
  inStationCalculations: z.boolean().optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  // Replaces the record's whole label list with this one.
  labelIds: z.array(z.uuid()).max(50).optional(),
  // Config fields (stored on StationVersion)
  standardCycle: z.number().positive().nullable().optional(),
  cycleMode: z.enum(["DISCRETE", "QUANTITY_PER_CYCLE", "QUANTITY_PER_INTERVAL"]).optional(),
  quantityUnit: z.string().optional(),
  standardRate: z.number().positive().nullable().optional(),
  standardRateUnit: z.string().optional(),
  standardRatePeriod: z.enum(["SECOND", "MINUTE", "HOUR"]).optional(),
  standardQuantity: z.number().positive().nullable().optional(),
  downtimeDetect: z.number().positive().nullable().optional(),
  downtimeDetectUnit: z.enum(["SECONDS"]).optional(),
  slowDetect: z.number().positive().nullable().optional(),
  slowDetectUnit: z.enum(["PERCENTAGE"]).optional(),
  inLineCalculations: z.boolean().optional(),
  inStationCalculations: z.boolean().optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const moveInputSchema = z.object({
  id: z.uuid(),
  workcenterId: z.uuid().nullable(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  workcenterId: z.uuid().optional(),
  // Only return stations that have at least one of these labels.
  labelIds: z.array(z.uuid()).max(50).optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

const triggerConditionSchema = z.object({
  id: z.string(),
  kind: z.literal("condition"),
  tagId: z.string().min(1),
  tagName: z.string().optional(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  condition: z.enum(["goes_above", "goes_below", "increments_up", "increments_down", "changes_to", "any_change"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

const triggerClauseSchema: z.ZodTypeAny = z.lazy(() => z.union([triggerConditionSchema, triggerGroupSchema]));

const triggerGroupSchema: z.ZodTypeAny = z.object({
  id: z.string(),
  kind: z.literal("group"),
  operator: z.enum(["all", "any"]),
  conditions: z.array(triggerClauseSchema).min(1),
});

const eventTriggerSchema = z.object({
  operator: z.enum(["all", "any"]),
  clauses: z.array(triggerClauseSchema).min(1),
});

const eventActionSchema = z.object({
  id: z.string(),
  event: z.string().min(1),
  eventDisplayName: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()),
  continueOnError: z.boolean().optional(),
});

const createEventInputSchema = z.object({
  stationId: z.uuid(),
  name: z.string().min(1),
  trigger: eventTriggerSchema,
  actions: z.array(eventActionSchema).min(1),
});

const updateEventInputSchema = z.object({
  stationId: z.uuid(),
  eventId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  updates: z
    .object({
      name: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
      trigger: eventTriggerSchema.optional(),
      actions: z.array(eventActionSchema).min(1).optional(),
    })
    .refine((value) => Object.keys(value).length > 0, {
      message: "At least one update field is required",
    }),
});

const stationEventIdInputSchema = z.object({
  stationId: z.uuid(),
  eventId: z.uuid(),
});

const listEventsInputSchema = z.object({
  stationId: z.uuid(),
});

const listEventExecutionsInputSchema = z.object({
  stationId: z.uuid(),
  limit: z.number().int().min(0).default(10),
});

const listEventsForProcessorInputSchema = z
  .object({
    stationId: z.uuid().optional(),
  })
  .optional();

const getTagSnapshotsForProcessorInputSchema = z.object({
  tagKeys: z.array(z.string().min(1)).min(1).max(500),
});

const toggleEventInputSchema = stationEventIdInputSchema.extend({
  enabled: z.boolean(),
});

const triggerEventInputSchema = z
  .object({
    stationId: z.uuid(),
    eventId: z.uuid(),
    payload: z.record(z.string(), z.unknown()).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => !(value.payload && value.data), {
    message: "Provide either payload or data, not both",
  });

// ============================================================================
// Procedures
// ============================================================================

/**
 * Create a new station
 */
export const create = userRequired.input(createInputSchema).handler(async ({ input, context }) => {
  // With a workcenter, the crew who manage that cell may create here (the
  // service checks the cell belongs to the site); without one it is a plant
  // thing.
  if (input.workcenterId) await context.access.require("MANAGE", { workcenter: input.workcenterId });
  else await context.access.require("MANAGE", { site: input.siteId });

  const result = await station.create(input);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * List stations
 */
export const list = userOrDisplayRequired.input(listInputSchema).handler(async ({ input, context }) => {
  // Displays are pinned to their own site by the policy; a workcenterId from
  // another site simply intersects to an empty result.
  const scope = context.access.list("VIEW", input.siteId, "WORKCENTER");
  return station.list({ ...input, ...scope });
});

/**
 * Get station by ID
 */
export const get = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { station: input.id });

  const result = await station.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Station not found" });
  }
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Update station
 */
export const update = userRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updateData } = input;
  await context.access.require("MANAGE", { station: id });

  const result = await station.update(id, updateData);
  if (result.error !== undefined) throwServiceError(result, UPDATE_OVERRIDES);
  return result.data;
});

/**
 * Move station to a different workcenter (within same site)
 */
export const move = userRequired.input(moveInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { station: input.id });
  // Moving INTO a workcenter also needs MANAGE there — otherwise a crew
  // could push stations into someone else's cell.
  if (input.workcenterId) await context.access.require("MANAGE", { workcenter: input.workcenterId });

  const result = await station.move(input.id, input.workcenterId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Delete station
 */
export const remove = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { station: input.id });

  const result = await station.remove(input.id);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

/**
 * Create station event
 */
export const createEvent = userRequired.input(createEventInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { station: input.stationId });

  const result = await station.createEvent(input as station.CreateStationEventInput);
  if ("error" in result && result.error !== undefined) throwServiceError(result, EVENT_ACTION_OVERRIDES);
  return result.data;
});

/**
 * Update station event
 */
export const updateEvent = userRequired.input(updateEventInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { station: input.stationId });

  const result = await station.updateEvent(input as station.UpdateStationEventInput);
  if ("error" in result && result.error !== undefined) throwServiceError(result, EVENT_ACTION_OVERRIDES);
  return result.data;
});

/**
 * List station events
 */
export const listEvents = userRequired.input(listEventsInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { station: input.stationId });

  const result = await station.listEvents(input.stationId);
  if ("error" in result && result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * List station event executions
 */
export const listEventExecutions = userRequired
  .input(listEventExecutionsInputSchema)
  .handler(async ({ input, context }) => {
    await context.access.require("VIEW", { station: input.stationId });

    const result = await station.listEventExecutions(input.stationId, undefined, {
      limit: input.limit,
    });
    if ("error" in result && result.error !== undefined) throwServiceError(result);
    return result.data;
  });

/**
 * List enabled station events for processor cache
 */
export const listEventsForProcessor = processorRequired
  .input(listEventsForProcessorInputSchema)
  .handler(async ({ input }) => {
    const result = await station.listEventsForProcessor(input?.stationId);
    // intentional catch-all mapping — see ADR-0003 (service currently emits no
    // error codes; any future one must stay INTERNAL_SERVER_ERROR here)
    if ("error" in result) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: result.error as string,
        cause: result,
      });
    }

    return result.data;
  });

/**
 * Get latest tag snapshots for processor cache misses
 */
export const getTagSnapshotsForProcessor = processorRequired
  .input(getTagSnapshotsForProcessorInputSchema)
  .handler(async ({ input }) => {
    const result = await station.getTagSnapshotsForProcessor(input.tagKeys);
    // intentional catch-all mapping — see ADR-0003 (service currently emits no
    // error codes; any future one must stay INTERNAL_SERVER_ERROR here)
    if ("error" in result) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: result.error as string,
        cause: result,
      });
    }

    return result.data;
  });

/**
 * Toggle station event
 */
export const toggleEvent = userRequired.input(toggleEventInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { station: input.stationId });

  const result = await station.toggleEvent(input.stationId, input.eventId, input.enabled);
  if ("error" in result && result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Trigger station event (processor-only)
 */
export const triggerEvent = processorRequired.input(triggerEventInputSchema).handler(async ({ input }) => {
  const result = await station.triggerEvent({
    stationId: input.stationId,
    eventId: input.eventId,
    payload: input.payload ?? input.data,
  } as station.TriggerStationEventInput);

  if ("error" in result && result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Delete station event
 */
export const deleteEvent = userRequired.input(stationEventIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { station: input.stationId });

  const result = await station.removeEvent(input.stationId, input.eventId);
  if ("error" in result && result.error !== undefined) throwServiceError(result);
  return { success: true };
});

// ============================================================================
// Datasource Management
// ============================================================================

const addDatasourceInputSchema = z.object({
  stationId: z.uuid(),
  datasourceIds: z.union([z.uuid(), z.array(z.uuid())]),
});

const removeDatasourceInputSchema = z.object({
  stationId: z.uuid(),
  datasourceId: z.uuid(),
});

const stationIdInputSchema = z.object({
  stationId: z.uuid(),
});

/**
 * Add one or more datasources to a station
 * Validates all belong to the same site
 */
export const addDatasource = userRequired.input(addDatasourceInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { station: input.stationId });

  const result = await station.addDatasource(input.stationId, input.datasourceIds);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * Remove a datasource from a station
 */
export const removeDatasource = userRequired.input(removeDatasourceInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { station: input.stationId });

  const result = await station.removeDatasource(input.stationId, input.datasourceId);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

/**
 * List all datasources linked to a station
 */
export const listDatasources = userRequired.input(stationIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { station: input.stationId });

  const result = await station.listDatasources(input.stationId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

// ============================================================================
// State Management
// ============================================================================

const splitDowntimeInputSchema = z.object({
  entryId: z.uuid(),
  splitAt: z.coerce.date(),
});

const stateLogOutputSchema = z.record(z.string(), z.unknown());

const splitDowntimeOutputSchema = z.object({
  success: z.literal(true),
  entries: z.tuple([stateLogOutputSchema, stateLogOutputSchema]),
});

const assignDowntimeReasonInputSchema = z.object({
  entryId: z.uuid(),
  statusReasonId: z.uuid().nullable(),
  applyToBlock: z.boolean().optional(),
  /** Per-period override of the reason's planned flag. */
  isPlannedDown: z.boolean().optional(),
});

const changeJobInputSchema = z.object({
  stationId: z.uuid(),
  jobId: z.uuid().nullable(),
});

const amendJobHistoryInputSchema = z.object({
  stationId: z.uuid(),
  jobId: z.uuid(),
  from: z.coerce.date(),
  to: z.coerce.date().nullable(),
  employeeId: z.uuid().optional(),
});

const listJobHistoryAmendmentsInputSchema = z.object({
  siteId: z.uuid(),
  stationId: z.uuid().optional(),
  limit: z.number().min(1).max(200).default(50),
  offset: z.number().min(0).default(0),
});

const listStateLogsInputSchema = z.object({
  stationId: z.uuid(),
  startTime: z.coerce.date().optional(),
  endTime: z.coerce.date().optional(),
  state: z.enum(["UP", "DOWN"]).optional(),
  limit: z.number().min(0).default(100),
  offset: z.number().min(0).default(0),
});

/**
 * Split a DOWN state log entry into two at a given duration
 */
export const splitDowntime = userOrDisplayRequired
  .input(splitDowntimeInputSchema)
  .output(splitDowntimeOutputSchema)
  .handler(async ({ input, context }) => {
    await context.access.require("MANAGE", { stationStateLog: input.entryId });

    const result = await station.splitDownEntry(input.entryId, input.splitAt);
    if ("error" in result) throwServiceError(result);
    return result;
  });

/**
 * Assign or clear a downtime reason on a DOWN state log entry
 */
export const assignDowntimeReason = userOrDisplayRequired
  .input(assignDowntimeReasonInputSchema)
  .handler(async ({ input, context }) => {
    await context.access.require("MANAGE", { stationStateLog: input.entryId });

    const result = await station.assignDowntimeReason(input.entryId, input.statusReasonId, {
      applyToBlock: input.applyToBlock,
      isPlannedDown: input.isPlannedDown,
    });
    if ("error" in result) throwServiceError(result);
    return result;
  });

/**
 * Change the current job assigned to a station
 */
export const changeJob = userOrDisplayRequired.input(changeJobInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { station: input.stationId });

  const result = await station.changeJob(input.stationId, input.jobId);
  if ("error" in result) throwServiceError(result);

  return result.data;
});

/**
 * Retroactively assert which job the station ran over [from, to). to = null
 * means through now and changes the current job. Facts are rewritten at once;
 * metric buckets rebuild asynchronously (see listJobHistoryAmendments.status).
 */
export const amendJobHistory = userOrDisplayRequired
  .input(amendJobHistoryInputSchema)
  .handler(async ({ input, context }) => {
    await context.access.require("MANAGE", { station: input.stationId });

    const { employeeId, ...window } = input;
    const result = await amendJobHistoryService({
      ...window,
      actor: { employeeId, userId: context.current.kind === "user" ? context.current.user.id : undefined },
    });
    if ("error" in result) throwServiceError(result);
    return result.data;
  });

export const listJobHistoryAmendments = userRequired
  .input(listJobHistoryAmendmentsInputSchema)
  .handler(async ({ input, context }) => {
    await context.access.require("VIEW", { site: input.siteId });
    return listAmendments(input);
  });

export const retryJobHistoryRebuild = userRequired
  .input(z.object({ amendmentId: z.uuid(), stationId: z.uuid() }))
  .handler(async ({ input, context }) => {
    await context.access.require("MANAGE", { station: input.stationId });
    const result = await retryRebuild(input.amendmentId);
    if ("error" in result) throwServiceError(result);
    return result.data;
  });

/**
 * List state logs for a station
 */
export const listStateLogs = userRequired.input(listStateLogsInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { station: input.stationId });

  return station.listStateLogs(input);
});

// ============================================================================
// Label filters — what this station accepts and what its pickers show
// ============================================================================

const setLabelFilterInputSchema = z.object({
  stationId: z.uuid(),
  target: z.enum(["JOB", "TOOL", "STATUS_REASON", "DISPOSITION_REASON"]),
  // The filter's labels. Empty or missing = remove the filter (no filtering).
  labelIds: z.array(z.uuid()).max(50).nullable().optional(),
});

/**
 * Set (or clear) one of the station's label filters.
 */
export const setLabelFilter = userRequired.input(setLabelFilterInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { station: input.stationId });

  const result = await station.setLabelFilter(input);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

/**
 * List the station's label filters.
 */
export const listLabelFilters = userRequired.input(stationIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { station: input.stationId });

  const result = await station.listLabelFilters(input.stationId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

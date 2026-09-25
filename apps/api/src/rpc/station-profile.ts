import { z } from "zod";
import { userRequired, userOrDisplayRequired } from "./middleware.js";
import { stationProfile } from "@rw/services/facility/index";
import { throwServiceError, unwrap } from "./errors.js";

// Station profiles (ADR-0017): named kinds of machine — how the signal
// counts, its unit, and the usual speed for new jobs.

const cycleModeSchema = z.enum(["DISCRETE", "QUANTITY_PER_CYCLE", "QUANTITY_PER_INTERVAL"]);
const ratePeriodSchema = z.enum(["SECOND", "MINUTE", "HOUR"]);

const fields = {
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  cycleMode: cycleModeSchema,
  quantityUnit: z.string().optional(),
  // Count by amount: how much one signal means (e.g. 100 ft).
  signalAmount: z.number().positive().nullable().optional(),
  // Count by time: seconds between reports.
  signalInterval: z.number().positive().nullable().optional(),
  // Count by time: finished parts (OUTPUT) or machine strokes (CYCLES).
  countedAs: z.enum(["OUTPUT", "CYCLES"]).optional(),
  // The usual speed: seconds per cycle (count by cycle) or a rate.
  standardCycle: z.number().positive().nullable().optional(),
  standardRate: z.number().positive().nullable().optional(),
  standardRateUnit: z.string().optional(),
  standardRatePeriod: ratePeriodSchema.optional(),
};

const createInputSchema = z.object({ siteId: z.uuid(), ...fields });

const updateInputSchema = z.object({
  id: z.uuid(),
  ...fields,
  name: fields.name.optional(),
  cycleMode: cycleModeSchema.optional(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  includeArchived: z.boolean().default(false),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

const idInputSchema = z.object({ id: z.uuid() });
const siteInputSchema = z.object({ siteId: z.uuid() });

export const create = userRequired.input(createInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.siteId });

  const result = await stationProfile.create(input);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const list = userOrDisplayRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = context.access.list("VIEW", input.siteId);
  return stationProfile.list({ ...input, ...scope });
});

export const get = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { stationProfile: input.id });

  return unwrap(await stationProfile.getById(input.id), { notFoundMessage: "Profile not found" });
});

/** The site's default profile, "Discrete" (made on first use). */
export const getDefault = userOrDisplayRequired.input(siteInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { site: input.siteId });

  return unwrap(await stationProfile.getDefault(input.siteId));
});

export const update = userRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { stationProfile: input.id });

  const { id, ...data } = input;
  const result = await stationProfile.update(id, data);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const archive = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { stationProfile: input.id });

  const result = await stationProfile.archive(input.id);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

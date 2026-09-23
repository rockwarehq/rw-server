import { z } from "zod";
import prisma from "@rw/db";
import { userRequired } from "./middleware.js";
import { crud, smsConsent } from "../services/employee/index.js";
import { throwServiceError, unwrap } from "./errors.js";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  siteId: z.uuid(),
  employeeNumber: z.string().min(1).nullable().optional(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  roleId: z.uuid().optional(),
  pin: z.string().min(4).max(8).optional(),
  badgeNumber: z.string().min(1).nullable().optional(),
  email: z.email().nullable().optional(),
  phone: z.string().min(3).max(32).nullable().optional(),
});

const listInputSchema = z.object({
  siteId: z.uuid(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  roleId: z.uuid().optional(),
  search: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  employeeNumber: z.string().min(1).nullable().optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  roleId: z.uuid().optional(),
  pin: z.string().min(4).max(8).optional(),
  badgeNumber: z.string().min(1).nullable().optional(),
  email: z.email().nullable().optional(),
  phone: z.string().min(3).max(32).nullable().optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

// Recorded against the employee's current phone number; A2P 10DLC wants the method on file.
const setSmsConsentInputSchema = z.object({
  employeeId: z.uuid(),
  status: z.enum(["OPTED_IN", "OPTED_OUT"]),
  method: z.enum(["WEB_FORM", "VERBAL", "PAPER", "TEXT_KEYWORD", "STOP_KEYWORD", "IMPORTED"]),
  note: z.string().max(500).nullable().optional(),
});

// ============================================================================
// Procedures
// ============================================================================

/**
 * The plants an employee works at. Changing an employee needs ADMIN at one
 * of them; an employee at no plant is left to the owner.
 */
async function employeeSites(employeeId: string): Promise<string[]> {
  const rows = await prisma.employeeSiteAccess.findMany({ where: { employeeId }, select: { siteId: true } });
  return rows.map((row) => row.siteId);
}

export const create = userRequired.input(createInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.siteId });

  const result = await crud.create(input);
  return result.data;
});

export const list = userRequired.input(listInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.siteId });

  return crud.list(input);
});

export const get = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const sites = await employeeSites(input.id);
  if (!sites.some((site) => context.access.can("ADMIN", { site }))) context.access.requireOwner();

  return unwrap(await crud.getById(input.id), { notFoundMessage: "Employee not found" });
});

export const update = userRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const sites = await employeeSites(input.id);
  if (!sites.some((site) => context.access.can("ADMIN", { site }))) context.access.requireOwner();

  const { id, ...updateData } = input;
  const result = await crud.update(id, updateData);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const remove = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const sites = await employeeSites(input.id);
  if (!sites.some((site) => context.access.can("ADMIN", { site }))) context.access.requireOwner();

  const result = await crud.remove(input.id);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

export const setSmsConsent = userRequired.input(setSmsConsentInputSchema).handler(async ({ input, context }) => {
  const sites = await employeeSites(input.employeeId);
  if (!sites.some((site) => context.access.can("ADMIN", { site }))) context.access.requireOwner();
  return unwrap(await smsConsent.set({ ...input, actorUserId: context.current.user.id }));
});

export const smsConsentHistory = userRequired
  .input(z.object({ employeeId: z.uuid() }))
  .handler(async ({ input, context }) => {
    const sites = await employeeSites(input.employeeId);
    if (!sites.some((site) => context.access.can("ADMIN", { site }))) context.access.requireOwner();
    return unwrap(await smsConsent.history(input.employeeId));
  });

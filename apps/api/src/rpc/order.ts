import { z } from "zod";
import { authRequired } from "./middleware.js";
import * as orderService from "@rw/services/order/order";
import { type CodeOverrides, throwServiceError, unwrap } from "./errors.js";

// This router historically mapped HAS_ALLOCATIONS to BAD_REQUEST (the shared
// default for HAS_* codes is CONFLICT). Pinned — observable codes are API.
const lineItemOverrides: CodeOverrides = { HAS_ALLOCATIONS: "BAD_REQUEST" };

// ============================================================================
// Input Schemas
// ============================================================================

const orderStatusEnum = z.enum(["DRAFT", "OPEN", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "CANCELLED"]);

const createInputSchema = z.object({
  siteId: z.uuid(),
  orderNumber: z.string().min(1),
  status: z.enum(["DRAFT", "OPEN"]).default("DRAFT"),
  customerId: z.uuid().optional(),
  poNumber: z.string().optional(),
  startDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
  priority: z.number().int().min(0).max(3).default(0),
  defaultTargetQuantity: z.number().int().min(1).default(1),
  notes: z.string().optional(),
  lineItems: z
    .array(
      z.object({
        productId: z.uuid(),
        targetQuantity: z.number().int().min(1),
      }),
    )
    .optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  orderNumber: z.string().min(1).optional(),
  customerId: z.uuid().nullable().optional(),
  poNumber: z.string().nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  priority: z.number().int().min(0).max(3).optional(),
  defaultTargetQuantity: z.number().int().min(1).optional(),
  notes: z.string().nullable().optional(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  status: z.union([orderStatusEnum, z.array(orderStatusEnum)]).optional(),
  customerId: z.uuid().optional(),
  search: z.string().optional(),
  limit: z.number().min(0).default(200),
  offset: z.number().min(0).default(0),
});

const idInputSchema = z.object({ id: z.uuid() });

const transitionStatusInputSchema = z.object({
  id: z.uuid(),
  status: z.enum(["OPEN", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "CANCELLED"]),
});

const addLineItemInputSchema = z.object({
  orderId: z.uuid(),
  productId: z.uuid(),
  targetQuantity: z.number().int().min(1),
});

const updateLineItemInputSchema = z.object({
  id: z.uuid(),
  targetQuantity: z.number().int().min(1).optional(),
});

const removeLineItemInputSchema = z.object({ id: z.uuid() });

const reorderInputSchema = z.object({
  siteId: z.uuid(),
  orderedIds: z.array(z.uuid()),
});

const nextNumberInputSchema = z.object({
  siteId: z.uuid(),
});

// ============================================================================
// Procedures
// ============================================================================

export const create = authRequired.input(createInputSchema).handler(async ({ input }) => {
  // DUPLICATE_PRODUCT here means duplicate products within the create payload
  // and historically fell through to BAD_REQUEST (unlike addLineItem, where the
  // same code is a CONFLICT with existing state).
  return unwrap(await orderService.create(input), { overrides: { DUPLICATE_PRODUCT: "BAD_REQUEST" } });
});

export const list = authRequired.input(listInputSchema).handler(async ({ input }) => {
  return orderService.list(input);
});

export const get = authRequired.input(idInputSchema).handler(async ({ input }) => {
  return unwrap(await orderService.get(input.id));
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  return unwrap(await orderService.update(id, updateData));
});

export const remove = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await orderService.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

export const transitionStatus = authRequired.input(transitionStatusInputSchema).handler(async ({ input }) => {
  return unwrap(await orderService.transitionStatus(input.id, input.status));
});

export const addLineItem = authRequired.input(addLineItemInputSchema).handler(async ({ input }) => {
  const result = await orderService.addLineItem(input.orderId, {
    productId: input.productId,
    targetQuantity: input.targetQuantity,
  });
  return unwrap(result, { overrides: lineItemOverrides });
});

export const updateLineItem = authRequired.input(updateLineItemInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  return unwrap(await orderService.updateLineItem(id, updateData), { overrides: lineItemOverrides });
});

export const removeLineItem = authRequired.input(removeLineItemInputSchema).handler(async ({ input }) => {
  const result = await orderService.removeLineItem(input.id);
  if (result.error) throwServiceError(result, lineItemOverrides);
  return { success: true };
});

export const reorder = authRequired.input(reorderInputSchema).handler(async ({ input }) => {
  const result = await orderService.reorder(input.siteId, input.orderedIds);
  return result;
});

export const nextNumber = authRequired.input(nextNumberInputSchema).handler(async ({ input }) => {
  return orderService.getNextOrderNumber(input.siteId);
});

import { z } from "zod";
import { authRequired } from "./middleware.js";
import { authorize, authorizeList, scopeFilter } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";
import * as orderService from "@rw/services/order/order";
import { throwServiceError, unwrap } from "./errors.js";

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
  // DEPRECATED: accepted for old clients, ignored — sequence is the only ordering.
  priority: z.number().int().min(0).max(3).default(0),
  defaultTargetQuantity: z.number().positive().default(1),
  notes: z.string().optional(),
  lineItems: z
    .array(
      z.object({
        productId: z.uuid(),
        targetQuantity: z.number().positive(),
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
  // DEPRECATED: accepted for old clients, ignored.
  priority: z.number().int().min(0).max(3).optional(),
  defaultTargetQuantity: z.number().positive().optional(),
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
  /** Completing with coverage < 100% requires explicit confirmation. */
  allowPartial: z.boolean().default(false),
});

const addLineItemInputSchema = z.object({
  orderId: z.uuid(),
  productId: z.uuid(),
  targetQuantity: z.number().positive(),
});

const updateLineItemInputSchema = z.object({
  id: z.uuid(),
  targetQuantity: z.number().positive().optional(),
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

export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "job:write", scope: { kind: "site", siteId: input.siteId } }));

  const { priority: _priority, ...createData } = input;
  // DUPLICATE_PRODUCT here means duplicate products within the create payload
  // and historically fell through to BAD_REQUEST (unlike addLineItem, where the
  // same code is a CONFLICT with existing state).
  return unwrap(await orderService.create(createData), { overrides: { DUPLICATE_PRODUCT: "BAD_REQUEST" } });
});

export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorizeList(context.iam, { permission: "job:read", requestedSiteId: input.siteId }));
  return orderService.list({ ...input, ...scopeFilter(scope) });
});

export const get = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "job:read", scope: { kind: "order", id: input.id } }));

  return unwrap(await orderService.get(input.id));
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "job:write", scope: { kind: "order", id: input.id } }));

  const { id, priority: _priority, ...updateData } = input;
  return unwrap(await orderService.update(id, updateData));
});

export const remove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "job:admin", scope: { kind: "order", id: input.id } }));

  const result = await orderService.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

export const transitionStatus = authRequired.input(transitionStatusInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "job:write", scope: { kind: "order", id: input.id } }));

  return unwrap(
    await orderService.transitionStatus(input.id, input.status, {
      allowPartial: input.allowPartial,
      source: "MANUAL",
      userId: context.iam.id ?? null,
    }),
  );
});

export const addLineItem = authRequired.input(addLineItemInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "job:write", scope: { kind: "order", id: input.orderId } }));

  const result = await orderService.addLineItem(input.orderId, {
    productId: input.productId,
    targetQuantity: input.targetQuantity,
  });
  return unwrap(result);
});

export const updateLineItem = authRequired.input(updateLineItemInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "job:write", scope: { kind: "orderLineItem", id: input.id } }));

  const { id, ...updateData } = input;
  return unwrap(await orderService.updateLineItem(id, updateData));
});

export const removeLineItem = authRequired.input(removeLineItemInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "job:write", scope: { kind: "orderLineItem", id: input.id } }));

  const result = await orderService.removeLineItem(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

export const reorder = authRequired.input(reorderInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "job:write", scope: { kind: "site", siteId: input.siteId } }));

  const result = await orderService.reorder(input.siteId, input.orderedIds);
  if ("error" in result && result.error) throwServiceError(result);
  return { success: true };
});

export const nextNumber = authRequired.input(nextNumberInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "job:read", scope: { kind: "site", siteId: input.siteId } }));

  return orderService.getNextOrderNumber(input.siteId);
});

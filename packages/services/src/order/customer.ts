import prisma from "@rw/db";
import { publishEntityEvent } from "../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../entity/registry.js";

// ============================================================================
// Types
// ============================================================================

export interface CreateCustomerInput {
  siteId: string;
  name: string;
}

export interface UpdateCustomerInput {
  name?: string;
}

export interface ListCustomersFilter {
  siteId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

// ============================================================================
// CRUD
// ============================================================================

export async function create(input: CreateCustomerInput) {
  const { siteId, name } = input;

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, workspaceId: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  const existing = await prisma.customer.findUnique({
    where: { siteId_name: { siteId, name } },
    select: { id: true, deletedAt: true },
  });

  if (existing && !existing.deletedAt) {
    return { error: "A customer with this name already exists", code: "DUPLICATE_NAME" };
  }

  const customer = await prisma.customer.create({
    data: { name, siteId },
  });

  publishEntityEvent({
    action: "created",
    entityKey: SYSTEM_ENTITY_KEYS.Customer,
    entityId: customer.id,
    siteId: customer.siteId,
    workspaceId: site.workspaceId,
  });

  return { data: customer };
}

export async function list(filter: ListCustomersFilter = {}) {
  const { siteId, search, limit = 200, offset = 0 } = filter;

  const where: Record<string, unknown> = { deletedAt: null };

  if (siteId) {
    where.siteId = siteId;
  }

  if (search) {
    where.name = { contains: search, mode: "insensitive" };
  }

  const [customers, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.customer.count({ where }),
  ]);

  return { data: customers, total, limit: Number(limit), offset: Number(offset) };
}

export async function getById(id: string) {
  const customer = await prisma.customer.findUnique({
    where: { id },
  });

  if (!customer || customer.deletedAt) {
    return { error: "Customer not found", code: "CUSTOMER_NOT_FOUND" };
  }

  return { data: customer };
}

export async function update(id: string, input: UpdateCustomerInput) {
  const customer = await prisma.customer.findUnique({
    where: { id },
    select: { id: true, siteId: true, deletedAt: true, site: { select: { workspaceId: true } } },
  });

  if (!customer || customer.deletedAt) {
    return { error: "Customer not found", code: "CUSTOMER_NOT_FOUND" };
  }

  if (input.name) {
    const existing = await prisma.customer.findUnique({
      where: { siteId_name: { siteId: customer.siteId, name: input.name } },
      select: { id: true, deletedAt: true },
    });
    if (existing && !existing.deletedAt && existing.id !== id) {
      return { error: "A customer with this name already exists", code: "DUPLICATE_NAME" };
    }
  }

  const updated = await prisma.customer.update({
    where: { id },
    data: input,
  });

  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Customer,
    entityId: updated.id,
    siteId: updated.siteId,
    workspaceId: customer.site.workspaceId,
    changedFields: Object.keys(input),
  });

  return { data: updated };
}

export async function remove(id: string) {
  const customer = await prisma.customer.findUnique({
    where: { id },
    select: {
      id: true,
      siteId: true,
      deletedAt: true,
      site: { select: { workspaceId: true } },
      _count: { select: { orders: { where: { deletedAt: null } } } },
    },
  });

  if (!customer || customer.deletedAt) {
    return { error: "Customer not found", code: "CUSTOMER_NOT_FOUND" };
  }

  if (customer._count.orders > 0) {
    return { error: "Cannot delete customer with active orders", code: "HAS_ORDERS" };
  }

  await prisma.customer.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  publishEntityEvent({
    action: "deleted",
    entityKey: SYSTEM_ENTITY_KEYS.Customer,
    entityId: customer.id,
    siteId: customer.siteId,
    workspaceId: customer.site.workspaceId,
  });

  return { success: true };
}
